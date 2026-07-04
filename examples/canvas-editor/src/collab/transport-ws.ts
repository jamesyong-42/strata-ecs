/**
 * The WebSocket transport — the SAME {@link Channel} envelope surface as the BroadcastChannel wrapper
 * (collab/transport.ts), but the bytes cross MACHINES over a real `ws://` relay (examples/collab-server)
 * instead of same-origin tabs. boot.ts and presence.ts wire to it identically; only the optional
 * {@link ConnectionLifecycle} is extra (they are always-connected, this one is not).
 *
 * FRAME LAYOUT (one WS binary frame per envelope):
 *
 *   ┌──────────────────┬───────────────────────────┬──────────────────────────┐
 *   │ u32 LE headerLen │ header JSON (UTF-8)        │ payload bytes            │
 *   └──────────────────┴───────────────────────────┴──────────────────────────┘
 *     4 bytes            headerLen bytes              (rest of the frame)
 *
 *   header = { "kind": Envelope["kind"], "from": PeerId, "to"?: PeerId }
 *   payload = envelope.bytes VERBATIM (absent → zero-length payload). `bytes` decodes back to
 *   `undefined` iff the payload is empty — `hello` is the only bytes-less kind; `durable`/`snapshot`/
 *   `ephemeral` always carry a non-empty CRDT payload, so the empty ⇔ absent mapping round-trips.
 *
 * A JSON header keeps the small addressing fields human-debuggable on the wire; the CRDT payload rides
 * as raw bytes with no base64 tax. The relay is DUMB — it never decodes this; it broadcasts the exact
 * frame to the other room members (per-connection WS ordering is the per-peer causal order 006 §A4
 * requires). All `from`/`to` filtering happens client-side here, exactly as the BroadcastChannel wrapper
 * does it.
 *
 * RECONNECT = FULL RE-BOOTSTRAP (006 §A4 transport-ordering addendum + §C7 item 5, the mandated policy):
 * a dropped socket may have dropped increments, so on reconnect we do NOT resume a half-synced stream —
 * boot.ts re-runs the whole bidirectional bootstrap (hello + own snapshot; existing peers respond;
 * buffered inbound drains after). This module owns only the SOCKET lifecycle: it reconnects with
 * exponential backoff (capped ~5s) and reports open/close through {@link ConnectionLifecycle}; boot.ts
 * owns the re-bootstrap. While not OPEN, `post` DROPS durable/ephemeral (the reconnect snapshot supersedes
 * durable; ephemeral is TTL-self-healed) — `hello`/`snapshot` are only ever posted from the onOpen
 * callback, i.e. when the socket is open.
 */

import type { Channel, ConnectionLifecycle, Envelope, PeerId } from "./transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

/** The default relay origin — a bare `?ws` (no URL) points the client here. */
export const DEFAULT_RELAY_ORIGIN = "ws://localhost:8787";

/**
 * Turn the `?ws[=<origin>]` param + the room into a full relay URL: `<origin>/<room>`. A bare `?ws`
 * (empty string) uses {@link DEFAULT_RELAY_ORIGIN}. The room rides in the URL PATH so the relay routes
 * by path alone and never parses a join message.
 */
export function resolveRelayUrl(origin: string, room: string): string {
  const base = origin === "" ? DEFAULT_RELAY_ORIGIN : origin;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
}

/** Serialize an envelope to one binary frame (see the module-header FRAME LAYOUT). */
function encodeFrame(env: Envelope): Uint8Array {
  const header =
    env.to !== undefined
      ? { kind: env.kind, from: env.from, to: env.to }
      : { kind: env.kind, from: env.from };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const payload = env.bytes ?? EMPTY;
  const frame = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, true);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.byteLength);
  return frame;
}

/** Parse one binary frame back to an envelope; returns `null` on any malformed frame (defensive, dropped). */
function decodeFrame(buf: ArrayBuffer): Envelope | null {
  try {
    if (buf.byteLength < 4) return null;
    const headerLen = new DataView(buf).getUint32(0, true);
    if (4 + headerLen > buf.byteLength) return null;
    const header = JSON.parse(decoder.decode(new Uint8Array(buf, 4, headerLen))) as {
      kind: Envelope["kind"];
      from: PeerId;
      to?: PeerId;
    };
    // The relay is a dumb byte pipe, so header fields are PEER-CONTROLLED: validate shape before use.
    // A `from`-less hello would otherwise make a bootstrapped peer reply `to: undefined` — an
    // un-addressed room-wide snapshot any hostile member could trigger at will (review finding).
    if (typeof header.from !== "string" || header.from.length === 0) return null;
    if (header.to !== undefined && typeof header.to !== "string") return null;
    if (header.kind !== "durable" && header.kind !== "ephemeral" && header.kind !== "hello" && header.kind !== "snapshot") return null;
    const payloadLen = buf.byteLength - 4 - headerLen;
    const bytes = payloadLen > 0 ? new Uint8Array(buf.slice(4 + headerLen)) : undefined;
    return { kind: header.kind, from: header.from, to: header.to, bytes };
  } catch {
    return null;
  }
}

/**
 * A {@link Channel} over a reconnecting WebSocket, plus two extras the collab-smoke uses (never part of
 * the {@link Channel} contract boot/presence see): {@link WebSocketChannel.ready} (a first-open barrier)
 * and {@link WebSocketChannel.dropForTest} (force a drop to exercise the reconnect re-bootstrap).
 */
export interface WebSocketChannel extends Channel {
  lifecycle: ConnectionLifecycle;
  /** Resolves on the first socket open (immediately if already open). The smoke awaits this before it hellos. */
  ready(): Promise<void>;
  /** TEST-ONLY: close the underlying socket to force the reconnect path (the smoke's relay-drop scenario). */
  dropForTest(): void;
}

export interface WebSocketChannelOptions {
  room: string;
  self: PeerId;
  /** The fully-resolved relay URL, including the `/<room>` path (see {@link resolveRelayUrl}). */
  url: string;
}

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

/**
 * Open a reconnecting relay client for one peer. Filters inbound EXACTLY like the BroadcastChannel wrapper
 * (drop our own echo; drop envelopes addressed elsewhere). Owns its socket lifecycle: on an unexpected
 * close it reconnects with exponential-ish backoff (capped ~5s) and reports each open/close through
 * {@link ConnectionLifecycle} so boot.ts can re-run the bootstrap. `close()` disposes for good (no reconnect).
 */
export function createWebSocketChannel(opts: WebSocketChannelOptions): WebSocketChannel {
  const { url, self } = opts;
  let socket: WebSocket | null = null;
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

  const isOpen = (): boolean => socket !== null && socket.readyState === WebSocket.OPEN;

  const scheduleReconnect = (): void => {
    if (disposed) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (disposed) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = (): void => {
      if (socket !== ws) return; // a stale socket we already moved past
      attempt = 0;
      const reconnect = everOpened;
      everOpened = true;
      resolveReady?.();
      for (const l of openListeners) l(reconnect);
    };
    ws.onmessage = (ev: MessageEvent): void => {
      if (socket !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return; // the relay only ever sends binary frames
      const env = decodeFrame(ev.data);
      if (env === null) return;
      if (env.from === self) return; // never act on our own echo (the relay excludes the sender; defensive)
      if (env.to !== undefined && env.to !== self) return; // addressed to a different peer
      handler?.(env);
    };
    ws.onclose = (): void => {
      if (socket !== ws) return; // a close for a socket we already discarded (dispose / superseded)
      socket = null;
      for (const l of closeListeners) l();
      scheduleReconnect();
    };
    ws.onerror = (): void => {
      // A connection error is always followed by a close event — let onclose own the drop + reconnect.
    };
  }

  connect();

  return {
    post: (env: Envelope): void => {
      // Not open ⇒ drop: durable increments are superseded by the reconnect snapshot; ephemeral is
      // TTL-self-healed; hello/snapshot are only posted from the onOpen callback (socket already open).
      if (isOpen()) socket!.send(encodeFrame(env));
    },
    onMessage: (fn): void => {
      handler = fn;
    },
    close: (): void => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      const ws = socket;
      socket = null; // null FIRST so the pending onclose sees `socket !== ws` and skips the reconnect
      if (ws !== null) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // already closing/closed — nothing to do
        }
      }
    },
    lifecycle: {
      onOpen: (fn): void => {
        openListeners.push(fn);
        if (isOpen()) fn(false); // sticky: a listener that registers after the first open still bootstraps
      },
      onClose: (fn): void => {
        closeListeners.push(fn);
      },
    },
    ready: (): Promise<void> => readyPromise,
    dropForTest: (): void => {
      if (socket !== null) socket.close(); // → onclose → closeListeners + scheduleReconnect (disposed is false)
    },
  };
}
