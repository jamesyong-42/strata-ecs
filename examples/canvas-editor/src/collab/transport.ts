/**
 * The transport — the app's job, not the framework's (design.md §14.2). The durable layer *converges*
 * a document; it never moves bytes. This module is the whole byte-moving surface: one
 * `BroadcastChannel("strata-collab:<room>")` between same-origin tabs, wrapping four envelope kinds.
 *
 * There is NO conflict-handling code here (that is the framework's, behind `doc.applyRemote`) — this is
 * purely a typed pipe. The self-test swaps the `BroadcastChannel` for an in-memory {@link Channel}
 * (collab/loopback.ts) with the identical surface, so the bootstrap + convergence logic is exercised
 * headlessly with no real tabs.
 */

/** A peer's per-session id — `crypto.randomUUID()` (006 B5); the envelope's `from`/`to` addressing. */
export type PeerId = string;

/**
 * The wire envelope. `bytes` is a `Uint8Array` — BroadcastChannel structured-clones it faithfully
 * (verified: typed arrays round-trip), so no base64 framing is needed.
 *  - `durable`   — a sealed-commit increment (rides `doc.subscribeOutbound`) → `doc.applyRemote`.
 *  - `ephemeral` — a presence blob (Part IV) → the ephemeral source's `apply` (wired in D1).
 *  - `hello`     — a joiner announcing itself; existing peers answer with a `snapshot`.
 *  - `snapshot`  — a full document (`doc.exportSnapshot()`) addressed `to` a joiner for its bootstrap.
 */
export interface Envelope {
  kind: "durable" | "ephemeral" | "hello" | "snapshot";
  from: PeerId;
  /** Addressed delivery (a `snapshot` answers one joiner); absent = broadcast to the room. */
  to?: PeerId;
  bytes?: Uint8Array;
}

/**
 * The transport surface the collab boot wires to — satisfied by the real `BroadcastChannel` wrapper
 * ({@link createBroadcastChannel}) and by the in-memory loopback shim (collab/loopback.ts). Structural
 * on purpose: the bootstrap state machine (collab/boot.ts) is written against this, never against
 * `BroadcastChannel` directly, so the self-test drives the identical code path.
 */
export interface Channel {
  /** Broadcast an envelope to the room (the sender never receives its own — BroadcastChannel semantics). */
  post(env: Envelope): void;
  /** Register the single inbound handler. A later call replaces the previous handler. */
  onMessage(fn: (env: Envelope) => void): void;
  /** Tear the transport down (the tab is leaving). */
  close(): void;
}

/** The room channel name — namespaced so unrelated same-origin BroadcastChannel traffic can't collide. */
export const channelName = (room: string): string => `strata-collab:${room}`;

/**
 * A real `BroadcastChannel` wrapped as a {@link Channel}. Drops envelopes not meant for `self`: an
 * envelope `from` self (defensive — BroadcastChannel already excludes the sender), or one addressed
 * `to` a different peer. Everything else reaches the handler verbatim.
 */
export function createBroadcastChannel(room: string, self: PeerId): Channel {
  const bc = new BroadcastChannel(channelName(room));
  let handler: ((env: Envelope) => void) | null = null;
  bc.onmessage = (ev: MessageEvent<Envelope>): void => {
    const env = ev.data;
    if (env.from === self) return; // never act on our own echo
    if (env.to !== undefined && env.to !== self) return; // addressed elsewhere
    handler?.(env);
  };
  return {
    post: (env) => bc.postMessage(env),
    onMessage: (fn) => {
      handler = fn;
    },
    close: () => bc.close(),
  };
}
