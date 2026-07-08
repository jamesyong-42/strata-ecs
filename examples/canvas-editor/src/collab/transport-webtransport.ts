/**
 * The WebTransport transport — the SAME {@link Channel} envelope surface as the WebSocket client
 * (collab/transport-ws.ts), but over ONE QUIC connection carrying the TWO delivery classes the transport
 * contract defines ({@link deliveryClassOf}, plan-transport):
 *
 *   reliable-ordered  (durable / hello / snapshot)  → ONE bidirectional STREAM
 *   latest-lossy      (ephemeral)                   → DATAGRAMS, auto-upgrading to the stream when a blob
 *                                                     exceeds the negotiated `datagrams.maxDatagramSize`
 *
 * boot.ts and presence.ts wire to this IDENTICALLY to the WS client — same `post`/`onMessage`/`close`, same
 * reconnect {@link ConnectionLifecycle}. Only the byte-moving underneath differs; there is still NO conflict
 * code here (the framework converges behind `doc.applyRemote`), just a typed two-lane pipe.
 *
 * WIRE FRAMING. An envelope encodes to the SAME blob the WS client uses (so the relay stays equally dumb):
 *
 *   BLOB = ┌──────────────────┬────────────────────┬──────────────┐
 *          │ u32 LE headerLen │ header JSON (UTF-8) │ payload bytes│
 *          └──────────────────┴────────────────────┴──────────────┘
 *          header = { kind, from, to? } ; payload = envelope.bytes verbatim (absent ⇒ empty)
 *
 * A QUIC datagram is a message (a boundary for free), so an ephemeral blob rides a datagram AS-IS. A QUIC
 * bidi stream is a raw BYTE stream with NO boundaries, so every blob sent on the stream is prefixed with a
 * u32-LE total length — STREAM FRAME = [u32 LE blobLen][blob] — which is exactly the boundary the relay
 * reads to forward whole frames without interleaving (wt-relay.js). The relay never looks inside a blob.
 *
 * RECONNECT = FULL RE-BOOTSTRAP, identical to the WS client (006 §A4 addendum + §C7 item 5): a dropped
 * QUIC connection may have dropped increments, so we do NOT resume a half-synced stream — this module owns
 * only the CONNECTION lifecycle (re-dial with capped exponential backoff, report open/close through
 * {@link ConnectionLifecycle}) and boot.ts re-runs the whole bidirectional bootstrap. While not connected,
 * `post` DROPS durable/ephemeral (the reconnect snapshot supersedes durable; ephemeral is TTL-self-healed);
 * hello/snapshot are only ever posted from the onOpen callback, i.e. once the stream is up.
 *
 * HOSTILE INBOUND: the relay is a dumb byte pipe, so every header field is peer-controlled — validated
 * before use, exactly as the WS client does it, and the receive path never throws (a bad frame is dropped).
 */

import {
  deliveryClassOf,
  type Channel,
  type ConnectionLifecycle,
  type Envelope,
  type PeerId,
} from "./transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

/** Outbound bytes we hand to DOM writers / `serverCertificateHashes` — TS 5.7 distinguishes a `Uint8Array`
 *  backed by a plain `ArrayBuffer` (what `new Uint8Array(n)` and `Uint8Array.from` produce) from the wider
 *  `ArrayBufferLike` default, and the WebTransport write/hash sinks require the former. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The default WebTransport relay origin — a bare `?wt` (no value) points the client here. */
export const DEFAULT_WT_ORIGIN = "https://127.0.0.1:4433";

/** Same guard the relay uses: never buffer an unbounded frame because a peer's length prefix said so. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

/**
 * Turn the `?wt[=<origin>]` param + the room into a full relay URL: `<origin>/<room>`. A bare `?wt` (empty
 * string) uses {@link DEFAULT_WT_ORIGIN}. The room rides in the URL PATH so the relay routes by path alone
 * and never parses a join message (mirrors {@link resolveRelayUrl} for WS).
 */
export function resolveWebTransportUrl(origin: string, room: string): string {
  const base = origin === "" ? DEFAULT_WT_ORIGIN : origin;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
}

/** Parse a colon-free lowercase hex SHA-256 (the relay's cert hash) into the bytes `serverCertificateHashes`
 *  wants. Tolerant: strips any stray colons/whitespace; a malformed hash yields bytes the handshake rejects,
 *  which the reconnect loop simply retries (no throw here). */
function hexToBytes(hex: string): Bytes {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const pairs = clean.match(/.{2}/g) ?? [];
  return Uint8Array.from(pairs, (b) => parseInt(b, 16));
}

/** Grow-only concat of two byte views into a fresh buffer (a stream read may split a frame arbitrarily). */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Serialize an envelope to its wire BLOB (see the module-header FRAMING). */
function encodeBlob(env: Envelope): Bytes {
  const header =
    env.to !== undefined
      ? { kind: env.kind, from: env.from, to: env.to }
      : { kind: env.kind, from: env.from };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const payload = env.bytes ?? EMPTY;
  const blob = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  new DataView(blob.buffer).setUint32(0, headerBytes.byteLength, true);
  blob.set(headerBytes, 4);
  blob.set(payload, 4 + headerBytes.byteLength);
  return blob;
}

/** Wrap a blob in a STREAM FRAME: `[u32 LE blobLen][blob]` (the length prefix the relay reads for boundaries). */
function frameForStream(blob: Bytes): Bytes {
  const frame = new Uint8Array(4 + blob.byteLength);
  new DataView(frame.buffer).setUint32(0, blob.byteLength, true);
  frame.set(blob, 4);
  return frame;
}

/** Parse one wire BLOB back to an envelope; returns `null` on any malformed blob (defensive, dropped). The
 *  validation MIRRORS collab/transport-ws.ts exactly — a `from`-less hello must not make a peer answer an
 *  un-addressed room-wide snapshot any hostile member could trigger. Payload bytes are COPIED so the retained
 *  envelope never aliases the receive buffer. */
function decodeBlob(blob: Uint8Array): Envelope | null {
  try {
    if (blob.byteLength < 4) return null;
    const headerLen = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(
      0,
      true,
    );
    if (4 + headerLen > blob.byteLength) return null;
    const header = JSON.parse(decoder.decode(blob.subarray(4, 4 + headerLen))) as {
      kind: Envelope["kind"];
      from: PeerId;
      to?: PeerId;
    };
    if (typeof header.from !== "string" || header.from.length === 0) return null;
    if (header.to !== undefined && typeof header.to !== "string") return null;
    if (
      header.kind !== "durable" &&
      header.kind !== "ephemeral" &&
      header.kind !== "hello" &&
      header.kind !== "snapshot"
    )
      return null;
    const payloadLen = blob.byteLength - 4 - headerLen;
    const bytes = payloadLen > 0 ? new Uint8Array(blob.subarray(4 + headerLen)) : undefined;
    return { kind: header.kind, from: header.from, to: header.to, bytes };
  } catch {
    return null;
  }
}

/**
 * A {@link Channel} over a reconnecting WebTransport, plus the same two smoke-only extras the WS client
 * exposes (never part of the {@link Channel} contract boot/presence see): {@link WebTransportChannel.ready}
 * (a first-open barrier) and {@link WebTransportChannel.dropForTest} (force a drop to exercise reconnect).
 */
export interface WebTransportChannel extends Channel {
  lifecycle: ConnectionLifecycle;
  /** Resolves on the first connection open (immediately if already open). */
  ready(): Promise<void>;
  /** TEST-ONLY: tear down the current connection to force the reconnect re-bootstrap path. */
  dropForTest(): void;
}

export interface WebTransportChannelOptions {
  room: string;
  self: PeerId;
  /** The fully-resolved relay URL, including the `/<room>` path (see {@link resolveWebTransportUrl}). */
  url: string;
  /** The relay's leaf-cert SHA-256 as colon-free hex — pinned via `serverCertificateHashes` (see certs.js). */
  certHashHex: string;
}

/**
 * Open a reconnecting WebTransport relay client for one peer. Filters inbound EXACTLY like the WS client
 * (drop our own echo; drop envelopes addressed elsewhere). Owns its connection lifecycle: on an unexpected
 * drop it re-dials with capped exponential backoff and reports each open/close through
 * {@link ConnectionLifecycle} so boot.ts can re-run the bootstrap. `close()` disposes for good (no reconnect).
 */
export function createWebTransportChannel(opts: WebTransportChannelOptions): WebTransportChannel {
  const { url, self, certHashHex } = opts;
  const hashBytes = hexToBytes(certHashHex);

  let transport: WebTransport | null = null;
  let streamWriter: WritableStreamDefaultWriter<Bytes> | null = null;
  let streamTail: Promise<unknown> = Promise.resolve(); // per-connection FIFO chain for reliable writes
  // The datagram sink is typed wider (`ArrayBufferLike`) than the bidi stream's in lib.dom; writing our
  // `Bytes` (a subtype) into it is fine, so keep the writer at the lib's own width.
  let dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let dgInFlight = false; // a datagram write is pending — drop new ones rather than queue (latest-lossy)

  let handler: ((env: Envelope) => void) | null = null;
  let disposed = false;
  let everOpened = false; // distinguishes the first open (reconnect:false) from every reopen (reconnect:true)
  let attempt = 0; // backoff exponent, reset on each successful open
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const openListeners: Array<(reconnect: boolean) => void> = [];
  const closeListeners: Array<() => void> = [];
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((res) => {
    resolveReady = res;
  });

  const isOpen = (): boolean => streamWriter !== null;

  const scheduleReconnect = (): void => {
    if (disposed) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  // Route an inbound blob (from the stream OR a datagram) to the handler, filtered exactly like the WS client.
  const deliver = (blob: Uint8Array): void => {
    const env = decodeBlob(blob);
    if (env === null) return;
    if (env.from === self) return; // never act on our own echo (the relay excludes the sender; defensive)
    if (env.to !== undefined && env.to !== self) return; // addressed to a different peer
    handler?.(env);
  };

  // A dropped/errored connection: drop back to un-bootstrapped and schedule a re-dial. Funnels BOTH
  // `transport.closed` settling and a failed handshake; the `transport !== wt` guard makes it fire once.
  const handleDrop = (wt: WebTransport): void => {
    if (transport !== wt) return; // a drop for a connection we already moved past
    transport = null;
    streamWriter = null;
    dgWriter = null;
    streamTail = Promise.resolve();
    dgInFlight = false;
    for (const l of closeListeners) l();
    scheduleReconnect();
  };

  // Read WHOLE `[u32 LE blobLen][blob]` frames off the reliable stream, decoding each blob to an envelope.
  const readStream = async (
    wt: WebTransport,
    readable: ReadableStream<Uint8Array>,
  ): Promise<void> => {
    const reader = readable.getReader();
    let buf: Uint8Array = new Uint8Array(0); // wide (ArrayBufferLike): fed by reads + concat, read-only here
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || transport !== wt) return;
        if (value && value.byteLength > 0) buf = concat(buf, value);
        while (buf.byteLength >= 4) {
          const blobLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
            0,
            true,
          );
          if (blobLen > MAX_FRAME_BYTES) return; // hostile/torn framing — stop; transport.closed reconnects
          const total = 4 + blobLen;
          if (buf.byteLength < total) break; // frame not fully arrived yet
          deliver(buf.subarray(4, total));
          buf = buf.subarray(total);
        }
      }
    } catch {
      // Stream torn — transport.closed owns the drop + reconnect.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  };

  // Read datagrams (each is a whole blob — a message boundary for free) and decode them.
  const readDatagrams = async (
    wt: WebTransport,
    readable: ReadableStream<Uint8Array>,
  ): Promise<void> => {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || transport !== wt) return;
        if (value && value.byteLength > 0) deliver(value);
      }
    } catch {
      // Datagram stream torn — transport.closed owns the drop + reconnect.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  };

  function connect(): void {
    if (disposed) return;
    let wt: WebTransport;
    try {
      wt = new WebTransport(url, {
        serverCertificateHashes: [{ algorithm: "sha-256", value: hashBytes }],
      });
    } catch {
      scheduleReconnect(); // a bad URL throws synchronously — retry so a transient config error self-heals
      return;
    }
    transport = wt;

    // `closed` resolves on a graceful close, rejects on an error close — either way we drop.
    wt.closed.then(
      () => handleDrop(wt),
      () => handleDrop(wt),
    );

    wt.ready.then(
      async () => {
        if (transport !== wt) return; // superseded by a newer connect before the handshake finished
        let stream: WebTransportBidirectionalStream;
        try {
          stream = await wt.createBidirectionalStream();
        } catch {
          handleDrop(wt);
          return;
        }
        if (transport !== wt) return;
        streamWriter = stream.writable.getWriter();
        try {
          dgWriter = wt.datagrams.writable.getWriter();
        } catch {
          dgWriter = null; // datagrams unavailable — every kind falls back to the reliable stream
        }
        void readStream(wt, stream.readable);
        void readDatagrams(wt, wt.datagrams.readable);

        attempt = 0;
        const reconnect = everOpened;
        everOpened = true;
        resolveReady?.();
        for (const l of openListeners) l(reconnect);
      },
      () => handleDrop(wt), // handshake failed (bad cert hash, relay down) — retry with backoff
    );
  }

  // Send an ephemeral blob as a datagram, DROPPING (never queuing) when a write is already in flight.
  const sendDatagram = (blob: Bytes): void => {
    if (dgWriter === null || dgInFlight) return;
    const w = dgWriter;
    dgInFlight = true;
    w.write(blob).then(
      () => {
        dgInFlight = false;
      },
      () => {
        dgInFlight = false; // a failed datagram write is just a dropped datagram
      },
    );
  };

  // Send a blob on the reliable stream, serialized through `streamTail` so frames keep order (backpressure
  // is honored by awaiting each write). A write error is swallowed — transport.closed drives the reconnect.
  const sendStream = (blob: Bytes): void => {
    if (streamWriter === null) return;
    const w = streamWriter;
    const frame = frameForStream(blob);
    streamTail = streamTail.then(() => w.write(frame)).catch(() => {});
  };

  connect();

  return {
    post: (env: Envelope): void => {
      const blob = encodeBlob(env);
      if (deliveryClassOf(env.kind) === "latest-lossy") {
        // Datagram when it fits the negotiated max; otherwise AUTO-UPGRADE to the reliable stream.
        const max = transport?.datagrams.maxDatagramSize ?? 0;
        if (dgWriter !== null && max > 0 && blob.byteLength <= max) {
          sendDatagram(blob);
          return;
        }
      }
      // reliable-ordered (or an over-sized ephemeral upgraded here). Not open ⇒ drop: durable is superseded
      // by the reconnect snapshot; ephemeral is TTL-self-healed; hello/snapshot only post from onOpen.
      if (streamWriter !== null) sendStream(blob);
    },
    onMessage: (fn): void => {
      handler = fn;
    },
    close: (): void => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      const wt = transport;
      transport = null; // null FIRST so the pending `closed` handler sees `transport !== wt` and skips reconnect
      streamWriter = null;
      dgWriter = null;
      if (wt !== null) {
        try {
          wt.close();
        } catch {
          /* already closing/closed */
        }
      }
    },
    lifecycle: {
      onOpen: (fn): void => {
        openListeners.push(fn);
        if (isOpen()) fn(false); // sticky: a listener registering after the first open still bootstraps
      },
      onClose: (fn): void => {
        closeListeners.push(fn);
      },
    },
    ready: (): Promise<void> => readyPromise,
    dropForTest: (): void => {
      const wt = transport;
      if (wt !== null) {
        try {
          wt.close(); // → transport.closed → handleDrop → closeListeners + scheduleReconnect (disposed is false)
        } catch {
          /* already closing */
        }
      }
    },
  };
}
