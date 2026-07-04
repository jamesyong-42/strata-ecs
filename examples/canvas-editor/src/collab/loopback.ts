/**
 * An in-memory {@link Channel} bus — the BroadcastChannel API with no browser, no tabs, no real time.
 *
 * Every channel minted from ONE `Loopback` shares its message bus: a `post` reaches every OTHER
 * channel on the bus (never the sender — the same same-context exclusion a real BroadcastChannel makes
 * between its own objects), honouring `to` addressing. It is also the foundation the headless multi-peer
 * self-test (collab/smoke.ts) builds on.
 *
 * TWO delivery modes (D2 — the self-test runs the WHOLE suite under both, asserting identical final
 * convergence):
 *  - **`"sync"`** (the default): a `post` fires the receivers' handlers INLINE, so a `hello` and its
 *    answering `snapshot` complete inside one call and the test drives each world's `sync()` by hand.
 *    Deterministic, no timer races — the D0/D1 shape.
 *  - **`"async"`**: each delivery defers to a `queueMicrotask`, so an increment lands AFTER the code that
 *    follows the `post` — the realistic BroadcastChannel timing where a bootstrap handshake takes real
 *    turns and increments can arrive before a snapshot. {@link Loopback.settle} is the barrier the test
 *    `await`s to drain the queue (cascades included) before it asserts.
 */

import type { Channel, Envelope, PeerId } from "./transport";

interface Endpoint {
  readonly self: PeerId;
  handler: ((env: Envelope) => void) | null;
}

/** Delivery timing (see the module doc): inline vs. microtask-deferred. */
export type LoopbackMode = "sync" | "async";

export class Loopback {
  private readonly endpoints = new Set<Endpoint>();
  /** async mode: deliveries scheduled but not yet run (cascades keep this > 0 until the room settles). */
  private pending = 0;
  /** async mode: resolvers waiting for the queue to fully drain (from {@link settle}). */
  private idle: Array<() => void> = [];

  constructor(private readonly mode: LoopbackMode = "sync") {}

  /** Mint a channel for `self`. Structurally a {@link Channel}, so the collab boot wires it identically. */
  channel(self: PeerId): Channel {
    const ep: Endpoint = { self, handler: null };
    this.endpoints.add(ep);
    return {
      post: (env: Envelope): void => {
        for (const other of this.endpoints) {
          if (other === ep) continue; // the sender never receives its own post
          if (other.self === env.from) continue; // defensive: same peer id on another endpoint
          if (env.to !== undefined && env.to !== other.self) continue; // addressed elsewhere
          if (this.mode === "sync") {
            other.handler?.(env);
          } else {
            // Defer like a real BroadcastChannel dispatch: read the handler AT DELIVERY time (a peer may
            // have replaced or closed it between post and delivery), and settle the room once every
            // scheduled delivery — plus any it cascaded — has run.
            this.pending++;
            queueMicrotask(() => {
              try {
                other.handler?.(env);
              } finally {
                if (--this.pending === 0) this.drainIdle();
              }
            });
          }
        }
      },
      onMessage: (fn) => {
        ep.handler = fn;
      },
      close: () => {
        this.endpoints.delete(ep);
      },
    };
  }

  /**
   * Resolve once the async delivery queue is fully drained — INCLUDING cascades (a delivered `snapshot`
   * that posts its own reply enqueues more work before the room settles). Immediate in sync mode (nothing
   * is ever queued). The self-test `await`s this at every cross-peer barrier so its assertions read a
   * settled world in either mode.
   */
  settle(): Promise<void> {
    if (this.mode === "sync" || this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private drainIdle(): void {
    const waiters = this.idle;
    this.idle = [];
    for (const w of waiters) w();
  }
}
