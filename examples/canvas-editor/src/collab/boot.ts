/**
 * The `?collab=<room>` boot path + the bootstrap protocol — the app's collab policy, small and labeled.
 *
 * TWO responsibilities, split:
 *  - {@link wireCollab} is the transport ↔ store wiring + the late-joiner bootstrap state machine. It is
 *    transport-agnostic (a {@link Channel}) and world-agnostic (it only touches `doc`), so the D0
 *    self-test drives the identical code over the in-memory loopback.
 *  - {@link startCollabBoot} is the browser entry: mint a peer id, construct the `LoroDoc` + store,
 *    attach it to the app's world, and hand `wireCollab` a real `BroadcastChannel` + the first-peer seed.
 *
 * THE BOOTSTRAP (the M1 lesson — an increment presupposes its causal base; a fresh receiver quarantines
 * on a bare increment): a joiner broadcasts `hello` and BUFFERS every inbound `durable` increment until
 * a `snapshot` addressed to it lands; it imports that whole document (the base), marks itself
 * bootstrapped, and drains the buffer in arrival order. An existing peer answers a `hello` with
 * `doc.exportSnapshot()` (everyone answers; the joiner takes the FIRST and ignores the rest — cheapest,
 * at the cost of N redundant snapshots on a full room). No answer within ~800ms ⇒ you are the first peer
 * ⇒ seed the board and mark bootstrapped. `PendingImportError` anywhere is surfaced (the quarantine
 * story) and should be UNREACHABLE thanks to the buffering — which is exactly the point.
 */

import { LoroDoc } from "loro-crdt";
import { attachDurable, createDurableStore, PendingImportError } from "strata-ecs/durable";
import { zoomToFit } from "../app/camera";
import { seedBoard } from "../app/seed";
import { world } from "../app/worldRef";
import { setActiveCollab } from "./mode";
import { startPresence } from "./presence";
import { createBroadcastChannel, type Channel } from "./transport";
import { createWebSocketChannel, resolveRelayUrl } from "./transport-ws";

/** How long a joiner waits for a `snapshot` before deciding it is the first peer and seeding. */
const HELLO_TIMEOUT_MS = 800;

export interface WireOptions {
  peerId: string;
  channel: Channel;
  /** An ATTACHED durable store — `doc.transaction` / `doc.applyRemote` / `doc.exportSnapshot` are live. */
  doc: ReturnType<typeof createDurableStore>;
  /** Seed the board into the DOCUMENT (first peer only). Runs inside its own `doc.transaction`. */
  seedFirst: () => void;
  /** HUD line for bootstrap state + the quarantine notice. */
  onStatus?: (msg: string) => void;
  /** Fires exactly once, the moment this peer becomes bootstrapped (seeded first, or joined via snapshot). */
  onBootstrapped?: () => void;
  /** Inbound presence blobs (D1): the transport's `ephemeral` envelopes → the ephemeral source's `apply`. */
  onEphemeral?: (bytes: Uint8Array) => void;
  helloTimeoutMs?: number;
}

export interface CollabWiring {
  isBootstrapped(): boolean;
  /** Take the first-peer path NOW without waiting out the hello timeout — the self-test's deterministic seed. */
  seedNow(): void;
  dispose(): void;
}

/**
 * Wire an attached store to a channel and run the bootstrap. Outbound: every sealed local commit rides
 * `subscribeOutbound` to the wire. Inbound: `durable` → `applyRemote` (or buffer pre-bootstrap),
 * `hello`/`snapshot` run the join handshake. No conflict code — the framework converges; this moves bytes.
 */
export function wireCollab(opts: WireOptions): CollabWiring {
  const { peerId, channel, doc } = opts;
  const timeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  let bootstrapped = false;
  // `true` once this peer has bootstrapped at least once — gates the fallback timer's action: the FIRST
  // round with no answer SEEDS (I am the first peer); a RECONNECT round with no answer RESUMES my existing
  // document WITHOUT re-seeding (re-seeding would fork the board). See startBootstrap.
  let everBootstrapped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const buffer: Uint8Array[] = [];

  // OUTBOUND wire (§14.2): each sealed LOCAL commit → the room.
  const unsubscribeOutbound = doc.subscribeOutbound((bytes) => {
    channel.post({ kind: "durable", from: peerId, bytes });
  });

  const applyDurable = (bytes: Uint8Array): void => {
    try {
      doc.applyRemote(bytes);
    } catch (err) {
      if (err instanceof PendingImportError) {
        // The buffering makes this unreachable in the happy path; surface it if it ever fires (§A4).
        opts.onStatus?.("collab: inbound quarantined (out-of-order import) — reload to resync");
      } else {
        throw err;
      }
    }
  };

  const become = (how: string): void => {
    if (bootstrapped) return;
    bootstrapped = true;
    everBootstrapped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (const b of buffer) applyDurable(b); // drain the pre-bootstrap buffer in arrival order (base is present)
    buffer.length = 0;
    opts.onStatus?.(how);
    opts.onBootstrapped?.();
  };

  channel.onMessage((env) => {
    switch (env.kind) {
      case "durable":
        if (env.bytes === undefined) return;
        if (bootstrapped) applyDurable(env.bytes);
        else buffer.push(env.bytes); // hold increments until the snapshot base lands (never applyRemote first)
        return;
      case "hello":
        // Answer a joiner with the whole document. Everyone answers; the joiner takes the first (cheapest).
        if (bootstrapped)
          channel.post({
            kind: "snapshot",
            from: peerId,
            to: env.from,
            bytes: doc.exportSnapshot(),
          });
        return;
      case "snapshot":
        if (env.bytes === undefined) return;
        if (!bootstrapped && (env.to === peerId || env.to === undefined)) {
          // MY bootstrap. Accept EITHER an addressed hello-answer (`to === me`) OR an un-addressed base
          // broadcast (`to === undefined`) — a full document is a full document. The un-addressed case is
          // load-bearing for SIMULTANEOUS (re)bootstrap: when a whole room reconnects at once (a relay
          // restart), every peer is briefly un-bootstrapped, so no one answers anyone's hello and each
          // times out onto the sole-peer RESUME path, which broadcasts its snapshot un-addressed. If an
          // un-bootstrapped receiver dropped those (accepting only addressed ones), the resumers would never
          // exchange state and edits made while disconnected would be lost. Import the doc (the causal base
          // for the buffered increments), then broadcast MY base so peers who predate me learn it too — my
          // future increments reference my construction commit that a pre-existing peer lacks (decision B),
          // or they would quarantine as missing-deps. Existing peers absorb my broadcast idempotently below.
          applyDurable(env.bytes);
          become("collab: joined room — synced from a peer");
          channel.post({ kind: "snapshot", from: peerId, bytes: doc.exportSnapshot() });
        } else if (bootstrapped && env.to === undefined) {
          // A peer sharing its base with the room (a joiner, or a resumer after reconnect) — absorb it
          // (idempotent) so its increments apply on me. This is what carries a reconnected peer's
          // disconnect-window edits to a peer that had already re-bootstrapped by the time it arrived.
          applyDurable(env.bytes);
        }
        // An addressed snapshot arriving after I am already bootstrapped is a redundant hello-answer — the
        // joiner took the first; ignore the rest (the cheap-responder tradeoff).
        return;
      case "ephemeral":
        // Presence blobs (D1): hand the bytes to the ephemeral source (boot wires `onEphemeral` to
        // `source.apply`). No bootstrap gating — ephemeral is TTL-self-healing, so a blob arriving before
        // durable bootstrap simply projects a live peer; it never presupposes the document's causal base.
        if (env.bytes !== undefined) opts.onEphemeral?.(env.bytes);
        return;
    }
  });

  // One bootstrap round: arm the first-peer/sole-peer fallback, THEN announce (a synchronous loopback
  // answer must find the timer set). Re-runnable — a reconnecting transport calls it again on reopen.
  const startBootstrap = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (bootstrapped) return;
      if (everBootstrapped) {
        // RECONNECT with no answer: I already hold the document — resume WITHOUT re-seeding. Broadcast my
        // snapshot in case a peer reconnected at the same instant and also timed out (each was un-bootstrapped
        // when the other's hello arrived, so neither answered) — the receiver absorbs it idempotently (§C7 #5).
        become("collab: reconnected — resumed (no peer answered)");
        channel.post({ kind: "snapshot", from: peerId, bytes: doc.exportSnapshot() });
      } else {
        // FIRST round with no answer: I am the first peer — seed the shared board.
        opts.seedFirst();
        become("collab: first peer — seeded the board");
      }
    }, timeoutMs);
    channel.post({ kind: "hello", from: peerId });
  };

  // KICKOFF. A connection-oriented transport (WS) drives the bootstrap from its socket lifecycle so the
  // hello goes out only once the socket is actually open, and RE-runs the full bidirectional bootstrap on
  // every reconnect (006 §A4 transport-ordering addendum + §C7 #5). An always-connected transport
  // (BroadcastChannel/loopback) has no `lifecycle` — kick off once, synchronously, and never re-bootstrap.
  if (channel.lifecycle !== undefined) {
    channel.lifecycle.onClose(() => {
      // A dropped socket may have dropped increments: drop back to un-bootstrapped and BUFFER inbound again.
      bootstrapped = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      opts.onStatus?.("collab: disconnected — buffering, will re-bootstrap on reconnect");
    });
    channel.lifecycle.onOpen((reconnect) => {
      if (reconnect) {
        bootstrapped = false; // usually already false from onClose; idempotent
        opts.onStatus?.("collab: reconnected — re-bootstrapping");
      }
      startBootstrap();
    });
  } else {
    startBootstrap();
  }

  return {
    isBootstrapped: () => bootstrapped,
    seedNow: () => {
      if (!bootstrapped) {
        opts.seedFirst();
        become("collab: first peer — seeded the board");
      }
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribeOutbound();
      channel.close();
    },
  };
}

/**
 * The browser `?collab=<room>` boot. Constructs the shared `LoroDoc`, wraps it in a durable store,
 * attaches it to the app's ONE world, installs the collab session (so editorOps/tools route document
 * ops through `doc.transaction`), and wires the transport with the bootstrap. NO autosave and NO
 * localStorage in collab mode — persistence stays a local-only concern (the caller skips `setOnMutate`).
 * The board seeds a demo-friendly count (a bootstrap snapshot ships over the wire on every join).
 *
 * TRANSPORT: `wsOrigin === null` (the default, no `?ws` param) uses a same-origin `BroadcastChannel`
 * between tabs — no server. Any string switches on the real WebSocket relay client (across machines): a
 * bare `?ws` is `""` → `ws://localhost:8787`; `?ws=<origin>` overrides the origin. The room rides in the
 * URL path. Both satisfy the identical {@link Channel} surface; only the WS one carries a reconnect
 * `lifecycle`, which drives wireCollab's re-bootstrap.
 */
export function startCollabBoot(
  room: string,
  count: number,
  notify: (msg: string) => void,
  renderChips: (text: string) => void,
  wsOrigin: string | null = null,
): CollabWiring {
  const peerId = crypto.randomUUID();
  const doc = createDurableStore(new LoroDoc()); // the ONE place a LoroDoc enters (§14.2)
  attachDurable(world, doc); // project the (empty) document in; register the drain — kept for the app's life
  setActiveCollab({ room, peerId, doc });

  // ONE channel, shared by durable + presence (a single `onMessage` handler in wireCollab routes both
  // envelope kinds — the transport's handler is replace-on-set, so the two layers cannot each register).
  let channel: Channel;
  if (wsOrigin !== null) {
    const url = resolveRelayUrl(wsOrigin, room);
    notify(`collab: connecting to relay ${url} …`);
    channel = createWebSocketChannel({ room, self: peerId, url });
  } else {
    channel = createBroadcastChannel(room, peerId);
  }
  // Presence rides the SAME peerId as the durable session (design §15's presence sketch) — session-unique.
  const presence = startPresence({ peerId, room, channel, doc, renderChips });

  const seedCount = Math.min(count, 400); // keep the shared board + its bootstrap snapshot demo-sized
  const wiring = wireCollab({
    peerId,
    channel,
    doc,
    seedFirst: () => doc.transaction((tx) => seedBoard(tx, seedCount)),
    onStatus: notify,
    // The seeded/synced entities reach the runtime via projection on the next sync()s — frame the board
    // once they are placed (two frames is safe: sync drains, then the board is queryable).
    onBootstrapped: () => requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit())),
    onEphemeral: presence.applyInbound, // inbound presence blobs → the ephemeral source's apply
    helloTimeoutMs: HELLO_TIMEOUT_MS,
  });

  // pagehide: leave() ships MY tombstones over the channel FIRST (peers despawn me now, not on TTL), then
  // dispose() tears down the durable channel + the ephemeral binding. `once: true` — pagehide can fire
  // again on a bfcache re-hide, and a second run would `channel.post` a tombstone through the channel the
  // first dispose() already closed (a throw on unload); tearing down exactly once is correct here.
  window.addEventListener(
    "pagehide",
    () => {
      presence.leave();
      wiring.dispose();
      presence.dispose();
    },
    { once: true },
  );
  return wiring;
}
