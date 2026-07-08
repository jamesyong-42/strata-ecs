/**
 * The strata-ecs collab relay over WebTransport — the SAME dumb byte-switchboard as the WebSocket relay
 * (src/server.js), but over ONE QUIC connection per client carrying TWO delivery classes (plan-transport):
 * a reliable-ordered bidirectional STREAM and lossy DATAGRAMS. Rooms are the URL path; every frame from a
 * member is fanned out verbatim to the OTHER members of its room. It never decodes an envelope, holds no
 * document state, runs no CRDT, resolves no conflicts — peers bootstrap each other over the app's own
 * hello→snapshot protocol (transport-webtransport.ts + boot.ts).
 *
 * TWO differences from the WS relay, both forced by the transport:
 *
 *  1. FRAME BOUNDARIES ON THE STREAM. A WebSocket delivers message boundaries for free, so server.js
 *     forwards each `data` verbatim without ever looking at it. A QUIC bidi stream is a raw BYTE stream —
 *     if we forwarded arbitrary read chunks, two senders' bytes could interleave mid-envelope on a peer's
 *     single stream and corrupt it. So the relay DOES parse the one framing field it must: the client
 *     length-prefixes each envelope blob with a u32-LE total length (matching transport-webtransport.ts);
 *     we read WHOLE `[u32-LE len][blob]` frames and write whole frames to peers. We still never look INSIDE
 *     the blob (the header/payload layout is the app's business) — only at the length prefix that bounds it.
 *
 *  2. TWO PATHS. Reliable frames ride each member's bidi stream (per-peer FIFO writes preserve order, the
 *     causal in-order delivery 006 §A4 requires while connected). Datagrams ride `session.datagrams`:
 *     fanned out verbatim, and DROPPED — never queued — when a peer's datagram writer is backpressured
 *     (latest-lossy is TTL-self-healing; queueing it would defeat the point and grow unboundedly).
 *
 * Like the WS relay: room membership lives only in memory for the lifetime of the sessions; a dropped
 * session just leaves; a reconnect triggers the client's full re-bootstrap, so the relay needs no memory
 * of who saw what. TLS/cert provisioning is src/certs.js; the combined launcher is src/start.js.
 *
 * Demo only — no auth, no authorization, no rate limiting. See the README's warning. The 13-day pinned-hash
 * cert is a demo escape hatch from a real PKI, not a production posture.
 */

import { Http3Server } from "@fails-components/webtransport";
import { loadOrCreateCert } from "./certs.js";

/**
 * All room traffic is routed to ONE internal session stream via the request callback (below); the real
 * room rides in the (rewritten) `:path` header. The native side only surfaces sessions whose final path
 * has a registered controller, so a single catch-all lets us accept ARBITRARY room paths with one reader.
 */
const CATCHALL_PATH = "/__strata_wt_relay__";

/** Hostile-input guard: a peer-controlled length prefix must not make us buffer without bound. 16 MiB is
 *  far above any demo snapshot; a frame claiming more is treated as a torn/hostile stream and the session
 *  is dropped rather than honored. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** ws://-relay-style room parse: the path (minus leading slashes, query stripped, percent-decoded) is the
 *  room; empty ⇒ "default". Guarded because the path is peer-controlled (a bad percent-escape must not throw
 *  out of the accept path). */
function roomOf(path) {
  const raw = (path ?? "/").split("?")[0].replace(/^\/+/, "");
  if (raw === "") return "default";
  try {
    return decodeURIComponent(raw) || "default";
  } catch {
    return raw; // undecodable but non-empty — route it verbatim rather than collapsing to default
  }
}

/** Grow-only concat of two byte views into a fresh buffer (each stream read may split a frame arbitrarily). */
function concat(a, b) {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Read WHOLE `[u32-LE len][blob]` frames off a QUIC bidi byte stream, yielding each frame's bytes VERBATIM
 * (the length prefix included) so the relay forwards it untouched. Accumulates across arbitrary read-chunk
 * boundaries; throws on a length prefix over {@link MAX_FRAME_BYTES} (caller drops the session). The yielded
 * frame is an owned copy — safe to hand to several peers' async writers at once.
 */
async function* readStreamFrames(readable) {
  const reader = readable.getReader();
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) buf = concat(buf, value);
      while (buf.byteLength >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
        if (len > MAX_FRAME_BYTES) {
          // Tagged so the pump distinguishes a genuine hostile/torn frame from an ordinary session
          // teardown (which also rejects the read) — only the former should warn + drop the session.
          const e = new Error(`frame length ${len} exceeds cap ${MAX_FRAME_BYTES}`);
          e.code = "FRAME_TOO_LARGE";
          throw e;
        }
        const total = 4 + len;
        if (buf.byteLength < total) break; // frame not fully arrived yet
        yield buf.slice(0, total); // owned copy of the whole [len][blob]
        buf = buf.subarray(total);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Start the WebTransport relay. `cert`/`privKey` are PEM (src/certs.js); `port`/`host` bind the QUIC socket;
 * `secret` is the server's session-signing secret. Resolves once the server is listening. Returns the
 * `Http3Server` and a `close()` that stops it. Mirrors src/server.js's `startRelay` shape (there: sync +
 * `wss`; here: async because `server.ready` is a promise).
 */
export async function startWtRelay({
  port,
  host = "127.0.0.1",
  cert,
  privKey,
  secret = "strata-collab",
}) {
  /** @type {Map<string, Set<Member>>} room name → its currently-joined members */
  const rooms = new Map();

  const server = new Http3Server({ port, host, secret, cert, privKey });

  // Accept ANY room path: rewrite every request onto the one catch-all stream and stash the parsed room.
  // The handler receives only `{ header }`; its result is merged into the native session-accept. We keep
  // the (query-stripped) real path in the header AND the parsed room in userData — either recovers the room.
  server.setRequestCallback(async ({ header }) => {
    const url = (header && header[":path"]) || "/";
    const [path] = url.split("?");
    return {
      path: CATCHALL_PATH,
      header: { ...header, ":path": path },
      userData: { room: roomOf(path) },
      status: 200,
      selectedProtocol: undefined, // the client requests no subprotocol
    };
  });

  const catchall = server.sessionStream(CATCHALL_PATH);
  server.startServer();
  await server.ready;

  const addToRoom = (room, member) => {
    let members = rooms.get(room);
    if (members === undefined) {
      members = new Set();
      rooms.set(room, members);
    }
    members.add(member);
    return members.size;
  };

  const leave = (member, why) => {
    if (member.left) return;
    member.left = true;
    const members = rooms.get(member.room);
    let size = 0;
    if (members !== undefined) {
      members.delete(member);
      size = members.size;
      if (size === 0) rooms.delete(member.room);
    }
    // Best-effort writer teardown so the QUIC streams don't dangle.
    try {
      member.streamWriter?.close().catch(() => {});
    } catch {
      /* already closed */
    }
    try {
      member.dgWriter?.close().catch(() => {});
    } catch {
      /* already closed */
    }
    console.log(`[wt-relay] - leave room="${member.room}" (${why}; ${size} left)`);
  };

  // STREAM fan-out: forward one whole frame to every OTHER member whose reliable stream is up. Per-peer
  // writes are serialized through `streamTail` so frames keep per-sender order and never interleave. A
  // peer whose stream isn't up yet is skipped — it will hello and bootstrap once its own stream is ready.
  const forwardStream = (sender, frame) => {
    const members = rooms.get(sender.room);
    if (members === undefined) return;
    for (const peer of members) {
      if (peer === sender || peer.streamWriter === null) continue;
      const w = peer.streamWriter;
      peer.streamTail = peer.streamTail
        .then(() => w.write(frame))
        .catch(() => {
          // A dead/backpressured-to-death peer rejects; its own close handler runs leave(). Swallow so one
          // bad peer can't break the chain for the others (each peer has its own tail).
        });
    }
  };

  // DATAGRAM fan-out: forward verbatim to every OTHER member, DROPPING (never queuing) for any peer whose
  // datagram writer is still in flight — latest-lossy tolerates loss, and queueing would grow unboundedly.
  const forwardDatagram = (sender, datagram) => {
    const members = rooms.get(sender.room);
    if (members === undefined) return;
    for (const peer of members) {
      if (peer === sender || peer.dgWriter === null || peer.dgInFlight) continue;
      peer.dgInFlight = true;
      peer.dgWriter.write(datagram).then(
        () => {
          peer.dgInFlight = false;
        },
        () => {
          peer.dgInFlight = false; // a failed datagram write is just a dropped datagram
        },
      );
    }
  };

  const pumpDatagrams = async (member) => {
    let reader;
    try {
      reader = member.session.datagrams.readable.getReader();
    } catch {
      return; // no datagram surface on this session
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0) forwardDatagram(member, value);
      }
    } catch {
      // Datagram stream torn — the session-closed handler owns leave().
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  };

  const pumpStreamFrames = async (member, readable) => {
    try {
      for await (const frame of readStreamFrames(readable)) forwardStream(member, frame);
    } catch (err) {
      if (err?.code === "FRAME_TOO_LARGE") {
        // A hostile/broken peer sent an oversized length prefix — drop it rather than honor the claim.
        console.warn(`[wt-relay] ! oversized frame room="${member.room}": ${err.message}`);
        leave(member, "frame-too-large");
        try {
          member.session.close();
        } catch {
          /* already closing */
        }
        return;
      }
      // Any other rejection is an ordinary stream teardown on session close — the session-closed handler
      // owns leave(); nothing to log.
    }
  };

  // The client opens exactly ONE bidi stream for reliable-ordered traffic. Its writable is where we forward
  // OTHER members' frames TO this client (server→client); its readable is this client's outbound. We take
  // the first stream's writable as the member's reliable writer and read+forward every incoming stream.
  const pumpIncomingStreams = async (member) => {
    let reader;
    try {
      reader = member.session.incomingBidirectionalStreams.getReader();
    } catch {
      return;
    }
    try {
      for (;;) {
        const { done, value: stream } = await reader.read();
        if (done) return;
        if (member.streamWriter === null) {
          try {
            member.streamWriter = stream.writable.getWriter();
          } catch {
            /* leave null — this member just won't receive reliable frames */
          }
        }
        void pumpStreamFrames(member, stream.readable);
      }
    } catch {
      // Session tearing down — the session-closed handler owns leave().
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  };

  const onSession = async (session) => {
    await session.ready;
    // Recover the room: the rewritten header holds the (query-stripped) path; userData carries the parse.
    const room = roomOf(session.header?.[":path"]) || session.userData?.room || "default";
    /** @type {Member} */
    const member = {
      session,
      room,
      left: false,
      streamWriter: null,
      streamTail: Promise.resolve(),
      dgWriter: null,
      dgInFlight: false,
    };
    const size = addToRoom(room, member);
    console.log(`[wt-relay] + join  room="${room}" (${size} in room)`);

    try {
      member.dgWriter = session.datagrams.createWritable().getWriter();
    } catch {
      member.dgWriter = null; // datagrams unavailable — reliable path still works
    }

    // A closed/errored session leaves the room. (`closed` resolves on graceful close, rejects on error.)
    session.closed.then(
      () => leave(member, "closed"),
      () => leave(member, "error"),
    );

    void pumpDatagrams(member);
    void pumpIncomingStreams(member);
  };

  // Accept loop — never let one bad session throw out of it.
  (async () => {
    const reader = catchall.getReader();
    try {
      for (;;) {
        const { done, value: session } = await reader.read();
        if (done) return;
        onSession(session).catch((err) =>
          console.warn(`[wt-relay] ! session setup error: ${err?.message ?? err}`),
        );
      }
    } catch (err) {
      console.error(`[wt-relay] accept loop error: ${err?.message ?? err}`);
    }
  })();

  return {
    server,
    close: () => {
      try {
        server.stopServer();
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * @typedef {object} Member
 * @property {import('@fails-components/webtransport').WebTransportSession} session
 * @property {string} room
 * @property {boolean} left                       leave() ran (idempotency guard)
 * @property {WritableStreamDefaultWriter | null} streamWriter  server→client reliable writer (null until the client's stream arrives)
 * @property {Promise<unknown>} streamTail         per-peer FIFO write chain (preserves frame order)
 * @property {WritableStreamDefaultWriter | null} dgWriter      server→client datagram writer
 * @property {boolean} dgInFlight                  a datagram write is pending (drop new ones until it resolves)
 */

// Standalone: `node src/wt-relay.js` starts ONLY the WT relay (provisioning a dev cert). The combined
// launcher that runs the WS relay AND this one together is src/start.js (`pnpm start:wt`).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.WT_PORT ?? 4433);
  const host = process.env.WT_HOST ?? "127.0.0.1";
  const c = await loadOrCreateCert();
  const { close } = await startWtRelay({ port, host, cert: c.cert, privKey: c.privateKey });
  console.log(`[wt-relay] listening on https://${host}:${port}  (rooms by URL path, e.g. /demo)`);
  console.log(`[wt-relay] client certHash: ${c.hashHex}`);
  const shutdown = () => {
    console.log("[wt-relay] shutting down");
    close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
