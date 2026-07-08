/**
 * canvas-desktop preload — injects the transport bridge the renderer's transport-ipc.ts binds to.
 *
 * The bridge is deliberately TRANSPORT-SHAPED (join/leave/post/onMessage + open/close lifecycle):
 * no Electron or truffle type reaches the renderer, so the canvas-editor stays a plain browser app
 * that happens to find `window.strataDesktop` present. Envelope objects cross the contextBridge by
 * structured clone — `bytes: Uint8Array` round-trips faithfully (same property BroadcastChannel
 * relies on, transport.ts), so no base64 framing anywhere.
 *
 * Each callback slot is single-handler replace-on-set, mirroring `Channel.onMessage`'s contract;
 * transport-ipc.ts multiplexes locally if it ever needs more. `onOpen` registered AFTER the open
 * already arrived fires immediately (`reconnect: false`) — the same no-race rule the WS transport's
 * lifecycle documents (transport.ts §ConnectionLifecycle).
 */
const { contextBridge, ipcRenderer } = require("electron");

let onMessage = null;
let onOpen = null;
let onClose = null;
/** Whether the switchboard has opened this window's membership (see main.mjs `collab:open`). */
let opened = false;

ipcRenderer.on("collab:msg", (_event, env) => onMessage?.(env));
ipcRenderer.on("collab:open", (_event, reconnect) => {
  opened = true;
  onOpen?.(reconnect);
});
ipcRenderer.on("collab:close", () => {
  opened = false;
  onClose?.();
});

contextBridge.exposeInMainWorld("strataDesktop", {
  /** Announce this window's room + peerId to the switchboard; it answers with `collab:open`. */
  join: (room, self) => ipcRenderer.send("collab:join", room, self),
  /** Withdraw from the switchboard (the channel is closing). */
  leave: () => ipcRenderer.send("collab:leave"),
  /** Ship one envelope to the switchboard for room delivery. */
  post: (env) => ipcRenderer.send("collab:post", env),
  onMessage: (fn) => {
    onMessage = fn;
  },
  onOpen: (fn) => {
    onOpen = fn;
    if (opened) fn(false); // late registration cannot race the first open
  },
  onClose: (fn) => {
    onClose = fn;
  },
});
