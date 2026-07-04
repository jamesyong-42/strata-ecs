/**
 * An in-memory {@link Channel} bus — the BroadcastChannel API with no browser, no tabs, no real time.
 *
 * Every channel minted from ONE `Loopback` shares its message bus: a `post` reaches every OTHER
 * channel on the bus (never the sender — the same same-context exclusion a real BroadcastChannel makes
 * between its own objects), honouring `to` addressing. Delivery is SYNCHRONOUS, which makes the D0
 * self-test fully deterministic (no timer races): a `hello` and its answering `snapshot` complete
 * inside one call, and the test then drives each world's `sync()` by hand. It is also the foundation
 * D2 builds its headless multi-peer harness on.
 */

import type { Channel, Envelope, PeerId } from "./transport";

interface Endpoint {
  readonly self: PeerId;
  handler: ((env: Envelope) => void) | null;
}

export class Loopback {
  private readonly endpoints = new Set<Endpoint>();

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
          other.handler?.(env);
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
}
