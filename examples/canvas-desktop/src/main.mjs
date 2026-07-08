/**
 * canvas-desktop main process — the strata-ecs canvas-editor as a minimal Electron app.
 *
 * The renderer is the UNCHANGED canvas-editor, loaded from its vite dev server; what the desktop
 * shell adds is a transport. This process is the room SWITCHBOARD, bridged into each window by
 * preload.cjs as `window.strataDesktop`; boot.ts selects the IPC channel whenever that bridge exists
 * (transport-ipc.ts) — the same {@link Channel} seam BroadcastChannel/WS/WebTransport satisfy.
 *
 * P1 (this file): the windows of THIS instance relay over IPC, under the collab-server contract
 * (examples/collab-server/src/server.js): never decode a payload, hold NO document state, resolve NO
 * conflicts. The only envelope fields the switchboard reads are the ADDRESSING ones (`to`, `from`) —
 * the loro bytes stay opaque. P2 adds a truffle mesh node here, making instances on other machines
 * room members over the tailnet (QUIC durable/snapshot lanes + UDP presence; docs plan) — the
 * switchboard stays CRDT-blind either way.
 *
 * Run: `pnpm example:canvas` (the UI dev server) in one terminal, then `pnpm example:desktop`.
 * Cmd/Ctrl+N opens another window in the same room — a second collaborator, no network involved.
 */
import { app, BrowserWindow, Menu, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The canvas-editor UI origin (its vite dev server); packaged loading is P3's problem. */
const CANVAS_URL = process.env.CANVAS_URL ?? "http://localhost:5173";
/** Every window of this instance joins one room (multi-room needs no more than a param later). */
const ROOM = process.env.STRATA_ROOM ?? "demo";
/** Test knobs (the CDP smoke + P3 harness): open N windows at launch; run ?script=<…> in the FIRST. */
const WINDOWS = Math.max(1, Number(process.env.STRATA_WINDOWS ?? "1") || 1);
const FIRST_WINDOW_SCRIPT = process.env.STRATA_SCRIPT ?? null;

const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");

/**
 * The switchboard's whole memory: webContents.id → membership. Entries live exactly as long as the
 * window's channel — added on `collab:join`, dropped on `collab:leave`/destroy. No document state.
 * @type {Map<number, { room: string, peerId: string, wc: Electron.WebContents }>}
 */
const members = new Map();

ipcMain.on("collab:join", (event, room, peerId) => {
  if (typeof room !== "string" || typeof peerId !== "string") return;
  members.set(event.sender.id, { room, peerId, wc: event.sender });
  // The membership is live from this moment; `reconnect: false` — IPC has no drops in P1 (the mesh
  // flap policy in P2 is what will ever send `collab:close` + reopen with `reconnect: true`).
  event.sender.send("collab:open", false);
  console.log(`[canvas-desktop] + join  room="${room}" peer=${peerId.slice(0, 8)} (${count(room)} in room)`);
});

ipcMain.on("collab:leave", (event) => {
  const m = members.get(event.sender.id);
  if (m === undefined) return;
  members.delete(event.sender.id);
  console.log(`[canvas-desktop] - leave room="${m.room}" (${count(m.room)} left)`);
});

ipcMain.on("collab:post", (event, env) => {
  const m = members.get(event.sender.id);
  if (m === undefined) return; // posted before join / after leave — nothing to route to
  // The whole job (server.js contract): forward to every OTHER member of the room, honoring only the
  // envelope's addressing. `env` itself is never validated beyond `to` — payloads are none of our business.
  const to = env === null || typeof env !== "object" ? undefined : env.to;
  for (const other of members.values()) {
    if (other.wc.id === event.sender.id || other.room !== m.room) continue;
    if (to !== undefined && to !== other.peerId) continue;
    if (!other.wc.isDestroyed()) other.wc.send("collab:msg", env);
  }
});

const count = (room) => [...members.values()].filter((m) => m.room === room).length;

/** Cascade offset per window so a multi-window launch never fully stacks (see throttling note). */
let windowIndex = 0;

function createWindow(script = null) {
  const i = windowIndex++;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    x: 80 + (i % 6) * 48,
    y: 80 + (i % 6) * 40,
    webPreferences: {
      preload: preloadPath, // contextIsolation + sandbox stay at their safe defaults
      // A fully-occluded Electron window reports `visibilityState: "hidden"` and Chromium FREEZES its
      // rAF loop — which is the app's tick, so a covered collaborator stops flushing presence AND stops
      // applying inbound sync (found by the P1 smoke: two same-position windows, peers stuck at 0).
      // A collab window must keep syncing while covered; the doc must be current when re-raised.
      backgroundThrottling: false,
    },
  });
  // A destroyed webContents must leave the room even when the renderer never sent `collab:leave`
  // (crash, hard close) — otherwise the switchboard forwards into a dead sink forever.
  win.webContents.once("destroyed", () => {
    const id = win.webContents.id;
    const m = members.get(id);
    if (m !== undefined) {
      members.delete(id);
      console.log(`[canvas-desktop] - leave room="${m.room}" (window destroyed; ${count(m.room)} left)`);
    }
  });
  const url =
    `${CANVAS_URL}/?collab=${encodeURIComponent(ROOM)}` +
    (script !== null ? `&script=${encodeURIComponent(script)}` : "");
  win.loadURL(url).catch(() => {
    // The one setup mistake everyone will make: the UI dev server isn't running. Say so, in-window.
    const msg = `canvas-desktop could not reach the canvas-editor dev server at ${CANVAS_URL}.<br/>` +
      `Start it first: <code>pnpm example:canvas</code> &nbsp;(then reload with Cmd/Ctrl+R)`;
    void win.loadURL(`data:text/html,<body style="font:16px system-ui;padding:2rem">${encodeURIComponent(msg)}</body>`);
  });
  return win;
}

app.whenReady().then(() => {
  // Minimal menu: the default roles plus the one desktop-specific verb — another window = another
  // collaborator in the room. (On the default menu Cmd+N does nothing; here it is the demo.)
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Collaborator Window", accelerator: "CmdOrCtrl+N", click: () => void createWindow() },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow(FIRST_WINDOW_SCRIPT);
  // STAGGERED, not simultaneous: two windows booting inside the same hello window (~800ms) both see
  // an empty room, both time out, and both SEED — two divergent geneses that quarantine each other on
  // first import (the split-seed race measured in the transport work; ≥ a couple of seconds of stagger
  // is the documented guidance). Humans opening Cmd+N windows stagger naturally; a launch loop must
  // do it deliberately. 2.5s clears hello (~800ms) + seed + snapshot-answer comfortably on localhost.
  for (let i = 1; i < WINDOWS; i++) setTimeout(() => void createWindow(), i * 2500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
