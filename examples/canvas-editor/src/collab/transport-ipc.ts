/**
 * The Electron-desktop transport (examples/canvas-desktop) — a {@link Channel} over the preload
 * bridge `window.strataDesktop`. The bridge is transport-shaped ON PURPOSE (join/post/onMessage +
 * open/close lifecycle, nothing Electron- or truffle-typed): the renderer stays a plain browser app,
 * and the desktop MAIN process is the switchboard — P1 relays between this instance's windows over
 * IPC; P2 adds tailnet instances as room members over truffle's mesh (QUIC durable/snapshot lanes +
 * UDP presence). Either way main is a dumb byte-mover under the collab-server contract: the loro
 * payloads in `bytes` are never decoded outside the framework.
 *
 * Unlike BroadcastChannel this channel HAS a {@link ConnectionLifecycle}: IPC itself never drops,
 * but the MESH does — on a peer-link change that could have dropped frames, main signals
 * close → open(`reconnect: true`), and wireCollab's existing re-bootstrap machinery (006 §A4 policy,
 * same as the WS relay client) does the rest. In P1 the lifecycle simply opens once and stays open.
 */
import type { Channel, Envelope, PeerId } from "./transport";

/** The preload-injected bridge (canvas-desktop/src/preload.cjs). Envelopes cross by structured clone. */
export interface StrataDesktopBridge {
  join(room: string, self: PeerId): void;
  leave(): void;
  post(env: Envelope): void;
  /** Single handler, replace-on-set — the same contract as {@link Channel.onMessage}. */
  onMessage(fn: (env: Envelope) => void): void;
  /** Registering after the open already happened fires immediately (`reconnect: false`). */
  onOpen(fn: (reconnect: boolean) => void): void;
  onClose(fn: () => void): void;
}

declare global {
  interface Window {
    /** Present only under the canvas-desktop Electron shell (injected by its preload script). */
    strataDesktop?: StrataDesktopBridge;
  }
}

/** Whether this renderer runs under the desktop shell — boot.ts's transport pick, before wt/ws/BC. */
export const hasDesktopBridge = (): boolean =>
  typeof window !== "undefined" && window.strataDesktop !== undefined;

/**
 * Wrap the preload bridge as a {@link Channel}. Mirrors createBroadcastChannel's defensive inbound
 * filter (own echo, addressed-elsewhere) even though the switchboard already applies it — the header
 * fields are peer-controlled once the mesh exists, and a duplicate check here is two comparisons.
 */
export function createIpcChannel(room: string, self: PeerId): Channel {
  const bridge = window.strataDesktop;
  if (bridge === undefined) throw new Error("createIpcChannel: no desktop bridge on window");
  // Probe marker (CDP smokes, __STALL_RESULT precedent): windows of one Electron instance share an
  // origin, so a broken IPC pick would FALL BACK to BroadcastChannel and still converge — the smoke
  // must assert the transport actually taken, not just convergence.
  (window as unknown as { __STRATA_TRANSPORT: string }).__STRATA_TRANSPORT = "ipc";
  let handler: ((env: Envelope) => void) | null = null;
  bridge.onMessage((env) => {
    if (env.from === self) return; // never act on our own echo
    if (env.to !== undefined && env.to !== self) return; // addressed elsewhere
    handler?.(env);
  });
  bridge.join(room, self);
  return {
    post: (env) => bridge.post(env),
    onMessage: (fn) => {
      handler = fn;
    },
    close: () => {
      handler = null;
      bridge.leave();
    },
    lifecycle: {
      onOpen: (fn) => bridge.onOpen(fn),
      onClose: (fn) => bridge.onClose(fn),
    },
  };
}
