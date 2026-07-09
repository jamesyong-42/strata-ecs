/**
 * canvas-desktop main process — the strata-ecs canvas-editor as a minimal Electron app.
 *
 * The renderer is the UNCHANGED canvas-editor, loaded from its vite dev server; what the desktop
 * shell adds is a transport. This process is the room SWITCHBOARD, bridged into each window by
 * preload.cjs as `window.strataDesktop`; boot.ts selects the IPC channel whenever that bridge exists
 * (transport-ipc.ts) — the same {@link Channel} seam BroadcastChannel/WS/WebTransport satisfy.
 *
 * P1: the windows of THIS instance relay over IPC. P2 (mesh.mjs): other instances on the tailnet are
 * room members too — truffle/tsnet discovery, QUIC durable/snapshot lanes, UDP presence. Both live
 * under the collab-server contract (examples/collab-server/src/server.js): never decode a payload,
 * hold NO document state, resolve NO conflicts. The only fields read are the ADDRESSING ones
 * (`room`/`kind`/`from`/`to`) — the loro bytes stay opaque.
 *
 * Routing is ONE-HOP and loop-free by construction: local frames → local windows + mesh links;
 * mesh frames → local windows only (never re-forwarded). `peerLoc` remembers which link a remote
 * peerId lives behind so `to`-addressed frames (snapshots) transit exactly one link.
 *
 * Run: `pnpm example:canvas` (the UI dev server) in one terminal, then `pnpm example:desktop`.
 * Cmd/Ctrl+N opens another window in the same room — a second collaborator, no network involved.
 * With a tailnet auth key in .env (TS_AUTHKEY), other machines running this app join the same rooms.
 */
import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { loadDotEnv, startMesh } from "./mesh.mjs";
import { startStaticServer } from "./static-server.mjs";

/**
 * The canvas-editor UI origin. Dev: the vite server (default :5173, `CANVAS_URL` overrides). Packaged:
 * there is no dev server, so an in-main loopback server (static-server.mjs) serves the BUILT renderer
 * and this is set to its origin before the first window opens. `CANVAS_URL` still wins everywhere, so
 * a packaged app can be pointed at a live dev server for debugging. `let`, not `const`: the packaged
 * branch replaces it in `app.whenReady`, and `createWindow` reads whatever it then holds.
 */
const CANVAS_URL_OVERRIDE = process.env.CANVAS_URL ?? null;
let CANVAS_URL = CANVAS_URL_OVERRIDE ?? "http://localhost:5173";
/** The packaged renderer server, kept for shutdown; null in dev / when CANVAS_URL is overridden. */
let staticServer = null;
/** Every window of this instance joins one room (multi-room needs no more than a param later). */
const ROOM = process.env.STRATA_ROOM ?? "demo";
/** Test knobs (the CDP smoke + P3 harness): open N windows at launch; run ?script=<…> in the FIRST. */
const WINDOWS = Math.max(1, Number(process.env.STRATA_WINDOWS ?? "1") || 1);
const FIRST_WINDOW_SCRIPT = process.env.STRATA_SCRIPT ?? null;
/** How long a fresh instance waits for a mesh link before opening windows anyway (see meshHold). */
const LINK_GRACE_MS = 8_000;

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(srcDir, "preload.cjs");

/**
 * The switchboard's whole memory: webContents.id → membership. Entries live exactly as long as the
 * window's channel — added on `collab:join`, dropped on `collab:leave`/destroy. No document state.
 * @type {Map<number, { room: string, peerId: string, wc: Electron.WebContents }>}
 */
const members = new Map();
/**
 * Where a peerId lives: `"local"` for this instance's windows, otherwise the deviceId of the mesh
 * link it was last heard through — how a `to`-addressed snapshot transits exactly one link.
 * @type {Map<string, string>}
 */
const peerLoc = new Map();
/** The mesh surface (mesh.mjs), or null while starting / when running local-only. */
let mesh = null;

const count = (room) => [...members.values()].filter((m) => m.room === room).length;

/** Deliver one envelope to local members of `room`, honoring `to`-addressing; never to `exceptWc`. */
function deliverLocal(room, env, exceptWcId) {
  for (const m of members.values()) {
    if (m.wc.id === exceptWcId || m.room !== room) continue;
    if (env.to !== undefined && env.to !== m.peerId) continue;
    if (!m.wc.isDestroyed()) m.wc.send("collab:msg", env);
  }
}

ipcMain.on("collab:join", (event, room, peerId) => {
  if (typeof room !== "string" || typeof peerId !== "string") return;
  members.set(event.sender.id, { room, peerId, wc: event.sender });
  peerLoc.set(peerId, "local");
  event.sender.send("collab:open", false);
  console.log(`[canvas-desktop] + join  room="${room}" peer=${peerId.slice(0, 8)} (${count(room)} in room)`);
});

const leave = (wcId, why) => {
  const m = members.get(wcId);
  if (m === undefined) return;
  members.delete(wcId);
  peerLoc.delete(m.peerId);
  console.log(`[canvas-desktop] - leave room="${m.room}" (${why}; ${count(m.room)} left)`);
};
ipcMain.on("collab:leave", (event) => leave(event.sender.id, "left"));

ipcMain.on("collab:post", (event, env) => {
  const m = members.get(event.sender.id);
  if (m === undefined || env === null || typeof env !== "object") return;
  deliverLocal(m.room, env, event.sender.id);
  if (mesh === null) return;
  // Addressed to one of OUR windows → the mesh never needs to see it (a local snapshot answer).
  if (env.to !== undefined && peerLoc.get(env.to) === "local") return;
  const toLink = env.to !== undefined ? peerLoc.get(env.to) : undefined;
  mesh.post(
    { room: m.room, kind: env.kind, from: env.from, ...(env.to !== undefined ? { to: env.to } : {}) },
    env.bytes,
    toLink === "local" ? undefined : toLink,
  );
});

/** Mesh inbound: remember where the sender lives, deliver locally, NEVER re-forward (one-hop). */
function onMeshFrame(header, payload, fromLink) {
  const { room, kind, from, to } = header;
  if (typeof room !== "string" || typeof kind !== "string" || typeof from !== "string") return;
  if (kind !== "durable" && kind !== "ephemeral" && kind !== "hello" && kind !== "snapshot") return;
  if (peerLoc.get(from) !== "local") peerLoc.set(from, fromLink);
  deliverLocal(room, { kind, from, to, bytes: payload }, -1);
}

/**
 * The 006 §A4 flap policy: a link change may have dropped frames only the re-bootstrap can repair,
 * so bounce every window's lifecycle (close → open(reconnect)) and let boot.ts re-run the full
 * bidirectional bootstrap. Debounced — N links settling at once is ONE bounce, not N.
 */
let bounceTimer = null;
function bounceWindows(why) {
  if (bounceTimer !== null) clearTimeout(bounceTimer);
  bounceTimer = setTimeout(() => {
    bounceTimer = null;
    console.log(`[canvas-desktop] bouncing ${members.size} window(s): ${why}`);
    for (const m of members.values()) if (!m.wc.isDestroyed()) m.wc.send("collab:close");
    setTimeout(() => {
      for (const m of members.values()) if (!m.wc.isDestroyed()) m.wc.send("collab:open", true);
    }, 100);
  }, 300);
}

/** Resolvers waiting on the first link (meshHold). */
const linkWaiters = new Set();

/**
 * Where the packaged app finds the truffle sidecar binary. Auto-resolution (require.resolve of the
 * platform package) returns an IN-asar path that cannot be spawned; asarUnpack puts a real copy under
 * `Resources/app.asar.unpacked/…`, and mesh.mjs takes an explicit `sidecarPath` for exactly this. The
 * package/binary names mirror truffle's own resolveSidecarPath so this stays right on other platforms.
 * Returns undefined in dev (auto-resolve from node_modules is correct there).
 */
function packagedSidecarPath() {
  if (!app.isPackaged) return undefined;
  const pkg = `@vibecook/truffle-sidecar-${process.platform}-${process.arch}`;
  const bin = process.platform === "win32" ? "sidecar-slim.exe" : "sidecar-slim";
  const p = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", ...pkg.split("/"), "bin", bin);
  if (existsSync(p)) return p;
  console.warn(`[canvas-desktop] packaged sidecar not found at ${p}; falling back to auto-resolve`);
  return undefined;
}

async function startMeshBridge() {
  // Config precedence (lowest→highest): the dev .env beside src, then the packaged user's .env in
  // userData, then real env vars. Packaged, `srcDir/..` is inside the asar (no .env shipped there —
  // the secret stays out of the bundle), so config comes from ~/…/canvas-desktop/.env or the env.
  const env = {
    ...loadDotEnv(path.join(srcDir, "..")),
    ...loadDotEnv(app.getPath("userData")),
    ...process.env,
  };
  const stateDir = process.env.STRATA_STATE_DIR ?? path.join(app.getPath("userData"), "tsnet");
  try {
    const api = await startMesh({
      authKey: env.TS_AUTHKEY,
      stateDir,
      deviceName: process.env.STRATA_DEVICE_NAME ?? `${os.hostname()}-canvas`,
      sidecarPath: packagedSidecarPath(),
      openUrl: (url) => void shell.openExternal(url),
      log: (msg) => console.log(`[mesh] ${msg}`),
      onFrame: onMeshFrame,
      onLinkChange: (kind, peerId) => {
        if (kind === "up") for (const w of linkWaiters) w();
        if (kind === "down") for (const [p, loc] of peerLoc) if (loc === peerId) peerLoc.delete(p);
        bounceWindows(`link ${kind} (${peerId.slice(0, 8)}…)`);
      },
    });
    mesh = api;
  } catch (err) {
    console.warn(`[canvas-desktop] mesh disabled (local-only): ${err.message}`);
  }
}

/**
 * Hold the first window until the mesh has met its peers — a window that hellos BEFORE the link is
 * up sees an empty room, seeds its own genesis, and quarantines against the instance it then meets
 * (the split-seed race, mesh edition). Sequential starts resolve cleanly: no online peers → open
 * immediately; peers exist → wait for the first link (or the grace cap, for ghost peers).
 */
async function meshHold(meshStart) {
  const started = await Promise.race([meshStart, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
  if (started === "timeout") {
    console.warn("[canvas-desktop] mesh still starting after 15s — opening local-only (links will bounce in)");
    return;
  }
  if (mesh === null || mesh.linkCount() > 0) return;
  const peers = (await mesh.onlinePeers()).length;
  if (peers === 0) return; // nobody out there — we are the first instance; seed away
  console.log(`[canvas-desktop] ${peers} instance(s) on the tailnet — waiting for a link (≤${LINK_GRACE_MS / 1000}s)…`);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      linkWaiters.delete(resolve);
      resolve();
    }, LINK_GRACE_MS);
    linkWaiters.add(() => {
      clearTimeout(timer);
      linkWaiters.delete(resolve);
      resolve();
    });
  });
}

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
  win.webContents.once("destroyed", () => leave(win.webContents.id, "window destroyed"));
  const url =
    `${CANVAS_URL}/?collab=${encodeURIComponent(ROOM)}` +
    (script !== null ? `&script=${encodeURIComponent(script)}` : "");
  win.loadURL(url).catch(() => {
    // Dev's one common mistake: the UI server isn't running. Packaged, a load failure means the
    // in-main renderer server didn't come up (unexpected) — either way, say so in-window.
    const msg = app.isPackaged
      ? `canvas-desktop could not load the packaged renderer from ${CANVAS_URL}.`
      : `canvas-desktop could not reach the canvas-editor dev server at ${CANVAS_URL}.<br/>` +
        `Start it first: <code>pnpm example:canvas</code> &nbsp;(then reload with Cmd/Ctrl+R)`;
    void win.loadURL(`data:text/html,<body style="font:16px system-ui;padding:2rem">${encodeURIComponent(msg)}</body>`);
  });
  return win;
}

/**
 * Packaged, there is no dev server: serve the built renderer (staged beside the app as `renderer/`)
 * over a loopback http origin and point CANVAS_URL at it. Skipped when CANVAS_URL is overridden (a
 * packaged app aimed at a live dev server) or in dev (the vite server is the origin).
 */
async function startRendererServer() {
  if (CANVAS_URL_OVERRIDE !== null || !app.isPackaged) return;
  const rendererDir = path.join(app.getAppPath(), "renderer");
  staticServer = await startStaticServer(rendererDir, (m) => console.log(`[canvas-desktop] ${m}`));
  CANVAS_URL = staticServer.origin;
}

const meshStart = app.whenReady().then(startMeshBridge);

app.whenReady().then(async () => {
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
  await startRendererServer(); // packaged: bring up the loopback renderer origin before any window
  await meshHold(meshStart);
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

// The tsnet node is EPHEMERAL — stopping it removes this instance from the tailnet. Do it on the
// way out (best-effort, capped: quit must not hang on a wedged sidecar).
let meshStopped = false;
app.on("will-quit", (event) => {
  void staticServer?.close(); // release the loopback port (best-effort; the OS reclaims it regardless)
  if (meshStopped || mesh === null) return;
  event.preventDefault();
  meshStopped = true;
  void Promise.race([mesh.stop(), new Promise((r) => setTimeout(r, 3_000))]).finally(() => app.quit());
});
