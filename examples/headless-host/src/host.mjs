/**
 * The document host — headless strata Worlds, server-side, one process, many rooms.
 *
 * This is the "fieldd DocumentHost" shape and the proof that headless/server hosting is a first-class
 * mode: no DOM, no requestAnimationFrame, no browser. Each room is an AUTHORITATIVE strata World +
 * DurableStore constructed lazily on first join; N rooms = N Worlds in the one Node process, all sharing
 * the process-global schema (schema.mjs). The host is BOTH the authority (it applies every client commit
 * into its own converged document and persists it to disk) AND the room's relay (it forwards each client's
 * bytes to the room's other clients, exactly like examples/collab-server does — but here backed by state).
 *
 * THE BIDIRECTIONAL BOOTSTRAP LAW (canvas-editor boot.ts): a joiner imports the host's snapshot as its
 * causal base, then sends ITS OWN base back. The host absorbs that base (idempotently) so the joiner's
 * later increments — which reference the joiner's construction commit — don't quarantine on the host; and
 * the host relays that base to the room's OTHER clients for the same reason (a peer that predates the
 * joiner otherwise lacks the joiner's construction commit and would quarantine its increments as
 * missing-deps). See README for the ops laws stated plainly.
 *
 * Run: `PORT=8788 node src/host.mjs` (PORT default 8788; DATA_DIR default ./data). Rooms are the URL path,
 * e.g. `ws://localhost:8788/design`. Ctrl-C flushes every room to disk and exits.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LoroDoc } from "loro-crdt";
import { WebSocketServer } from "ws";
import { createWorld, defineTickSystem, phase } from "@vibecook/strata-ecs";
import {
  attachDurable,
  createDurableStore,
  PendingImportError,
} from "@vibecook/strata-ecs/durable";
import { AllEntities, HostStats } from "./schema.mjs";
import { documentDigest, frame, KIND, unframe } from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8788); // NOT 8787 — that is the canvas-editor relay's default
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(HERE, "..", "data"));
const TICK_HZ = 30;
const STATUS_MS = 2000; // one status line per room on this cadence
const SAVE_DEBOUNCE_MS = 750; // trailing-debounce autosave; shutdown flushes synchronously regardless

mkdirSync(DATA_DIR, { recursive: true });

/** ws:// path → room name (leading slashes stripped, query dropped); "" → "default". */
function roomOf(url) {
  const path = (url ?? "/").split("?")[0].replace(/^\/+/, "");
  return decodeURIComponent(path) || "default";
}

const fileFor = (room) => join(DATA_DIR, `${encodeURIComponent(room)}.bin`);

/** @type {Map<string, Room>} live rooms by name. */
const rooms = new Map();

/**
 * Construct (or return the existing) room: LoroDoc + DurableStore + World + attachDurable, restore from
 * disk if present, and install the per-room tick system that maintains {@link HostStats}. Lazy, so a
 * process with three rooms holds three Worlds and no more.
 */
function getOrCreateRoom(name) {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;

  let doc = new LoroDoc();
  let store = createDurableStore(doc);
  let world = createWorld({ name: `room:${name}` });
  attachDurable(world, store);

  // Restore: the EMPTY-DOC bootstrap fast path — import the whole on-disk snapshot into the fresh store,
  // then project it. If the file is corrupt / causally impossible it quarantines: rename it aside and
  // start fresh, never brick boot (the canvas-editor autosave precedent).
  const file = fileFor(name);
  if (existsSync(file)) {
    try {
      store.applyRemote(new Uint8Array(readFileSync(file)));
      world.sync();
      console.log(
        `[headless-host] room="${name}" restored from disk (${documentDigest(store).entityCount} entities)`,
      );
    } catch (err) {
      if (err instanceof PendingImportError) {
        const quarantined = `${file}.quarantined-${Date.now()}`;
        renameSync(file, quarantined);
        console.warn(
          `[headless-host] room="${name}" disk snapshot quarantined → ${quarantined}; starting fresh`,
        );
        // A failed import PERMANENTLY quarantines that snapshot instance — every later applyRemote on it
        // throws before enqueuing — so "starting fresh" must mean a FRESH doc + store + world. Keeping the
        // poisoned store would brick the room: every client join would quarantine-drop forever.
        doc = new LoroDoc();
        store = createDurableStore(doc);
        world = createWorld({ name: `room:${name}` });
        attachDurable(world, store);
      } else {
        throw err;
      }
    }
  }

  /** @type {Room} */
  const room = {
    name,
    doc,
    store,
    world,
    sockets: new Set(),
    saveTimer: undefined,
    dead: false, // set by rebuildRoom: retired after a quarantine; racing handlers just close their socket
    disposeOutbound: undefined,
  };

  // The one trivial tick system: count the room's live entities and bump the tick counter, straight into
  // the runtime-local HostStats resource. It closes over THIS room's world (defineTickSystem is a plain
  // factory — one per room is fine). `world.setResource` is value-shaped, so it is legal mid-dispatch.
  const hostStats = defineTickSystem(
    (ctx) => {
      let entities = 0;
      ctx.query(AllEntities).each((batch) => {
        for (const _row of batch) entities++;
      });
      const prev = ctx.getResource(HostStats) ?? { entities: 0, ticks: 0 };
      world.setResource(HostStats, { entities, ticks: prev.ticks + 1 });
    },
    { name: "host-stats" },
  );
  room.pipeline = [phase("host", [hostStats])];

  // OUTBOUND seam: every LOCAL commit the host itself authors → the room. This example's host authors no
  // document content (it is a pure authority + relay), so this never fires — but it is the correct seam a
  // host that DID stamp document state would use, so it is wired honestly.
  room.disposeOutbound = store.subscribeOutbound((bytes) =>
    broadcast(room, frame(KIND.update, bytes), null),
  );

  rooms.set(name, room);
  console.log(`[headless-host] room="${name}" created (authoritative World attached)`);
  return room;
}

/** Send `buf` to every ready socket in the room except `except` (null = all). */
function broadcast(room, buf, except) {
  for (const sock of room.sockets) {
    if (sock !== except && sock.hhReady && sock.readyState === 1 /* OPEN */)
      sock.send(buf, { binary: true });
  }
}

/** Trailing-debounce an autosave of the room's converged document to `data/<room>.bin`. */
function scheduleSave(room) {
  if (room.saveTimer !== undefined) clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    room.saveTimer = undefined;
    saveNow(room);
  }, SAVE_DEBOUNCE_MS);
}

function saveNow(room) {
  try {
    writeFileSync(fileFor(room.name), Buffer.from(room.store.exportSnapshot()));
  } catch (err) {
    console.warn(`[headless-host] room="${room.name}" autosave failed: ${err.message}`);
  }
}

/**
 * Apply remote bytes into the room's authority. Returns true if applied. On ANY import failure the
 * offending socket is dropped — loro throws a bare string (not an Error) on undecodable bytes, so the
 * catch is total by design: one hostile payload must never kill the process (a failed decode leaves the
 * document unmutated; the room's other clients are unaffected). A PendingImportError additionally means
 * THIS room's store is now permanently quarantined (valid bytes whose causal deps the host lacks —
 * unreachable from a well-behaved client, since the bidirectional bootstrap law guarantees the host holds
 * every base before increments flow): recovery is to rebuild the room from its own live state and make
 * every client re-bootstrap; without it the room would brick (every later write quarantine-dropped).
 */
function applyOrDrop(room, socket, bytes, what) {
  if (room.dead) {
    // A message raced the rebuild on a socket that still holds the retired room — just finish closing it.
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    return false;
  }
  try {
    room.store.applyRemote(bytes);
    return true;
  } catch (err) {
    const why = err instanceof PendingImportError ? "quarantine" : "undecodable bytes";
    console.warn(
      `[headless-host] room="${room.name}" dropped a socket — ${why} on ${what} (client should reconnect)`,
    );
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    if (err instanceof PendingImportError) rebuildRoom(room);
    return false;
  }
}

/**
 * The runtime twin of the disk-restore rebuild: carry the room's live state into a FRESH doc + store +
 * world and close every socket — their handlers captured the retired room object, so reconnection (and a
 * full re-bootstrap) is what binds them to the new one. The pre-pending state of a quarantined store is
 * intact and still exports; if even that fails, getOrCreateRoom's disk restore supplies the last autosave.
 */
function rebuildRoom(room) {
  if (room.dead) return; // a second failure raced the rebuild — the new room is already up
  room.dead = true;
  let carried;
  try {
    carried = room.store.exportSnapshot();
  } catch {
    carried = undefined;
  }
  rooms.delete(room.name);
  room.disposeOutbound?.();
  if (room.saveTimer !== undefined) clearTimeout(room.saveTimer);
  for (const sock of [...room.sockets]) {
    try {
      sock.close();
    } catch {
      /* already closing */
    }
  }
  const fresh = getOrCreateRoom(room.name);
  if (carried !== undefined) {
    try {
      fresh.store.applyRemote(carried);
      fresh.world.sync();
    } catch {
      /* the disk restore already holds the last autosave — the carried state was best-effort */
    }
  }
  saveNow(fresh);
  console.warn(
    `[headless-host] room="${room.name}" rebuilt after quarantine — clients must re-bootstrap`,
  );
}

// --- the server ---------------------------------------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket, req) => {
  const room = getOrCreateRoom(roomOf(req.url));
  socket.hhReady = false; // becomes true once we have answered its hello with a snapshot
  socket.binaryType = "nodebuffer";
  room.sockets.add(socket);
  console.log(`[headless-host] + connect room="${room.name}" (${room.sockets.size} sockets)`);

  socket.on("message", (data) => {
    const { kind, kindName, payload } = unframe(data);
    switch (kind) {
      case KIND.hello: {
        // Answer with the whole converged document and mark the socket ready. Export + send + mark are one
        // synchronous unit, so no relayed update can slip in between the snapshot's contents and the point
        // the socket starts receiving relays.
        socket.send(frame(KIND.snapshot, room.store.exportSnapshot()), { binary: true });
        socket.hhReady = true;
        return;
      }
      case KIND.base: {
        // THE BIDIRECTIONAL LAW: absorb the joiner's base so its increments won't quarantine on us, then
        // relay it to the room's other clients so peers that predate the joiner absorb it too.
        if (applyOrDrop(room, socket, payload, "base import")) {
          broadcast(room, frame(KIND.base, payload), socket);
          scheduleSave(room);
        }
        return;
      }
      case KIND.update: {
        if (applyOrDrop(room, socket, payload, "update import")) {
          broadcast(room, frame(KIND.update, payload), socket);
          scheduleSave(room);
        }
        return;
      }
      default:
        console.warn(`[headless-host] room="${room.name}" ignoring unknown frame kind=${kindName}`);
    }
  });

  const drop = (why) => {
    room.sockets.delete(socket);
    console.log(
      `[headless-host] - disconnect room="${room.name}" (${why}; ${room.sockets.size} left)`,
    );
  };
  socket.on("close", () => drop("close"));
  socket.on("error", (err) => {
    console.warn(`[headless-host] socket error in room="${room.name}": ${err.message}`);
    drop("error");
  });
});

wss.on("listening", () => {
  const { port } = wss.address();
  // A parseable ready line (the smoke greps `ready port=<n>`); the second line is for humans.
  console.log(`[headless-host] ready port=${port} data=${DATA_DIR}`);
  console.log(
    `[headless-host] document host up — rooms by URL path, e.g. ws://localhost:${port}/design`,
  );
});
wss.on("error", (err) => console.error(`[headless-host] server error: ${err.message}`));

// The tick driver: NOT rAF. A plain ~30Hz timer runs each room's sync()+tick(). Deliberately three lines,
// which is exactly why a "tick driver" helper is NOT part of strata's public API (see README).
const tickTimer = setInterval(
  () => {
    for (const room of rooms.values()) {
      room.world.sync(); // drain applied client commits into the runtime
      room.world.tick(room.pipeline); // dispatch the host-stats system
    }
  },
  Math.round(1000 / TICK_HZ),
);

const statusTimer = setInterval(() => {
  for (const room of rooms.values()) {
    const stats = room.world.getResource(HostStats) ?? { entities: 0, ticks: 0 };
    console.log(
      `[headless-host] room="${room.name}" entities=${stats.entities} ticks=${stats.ticks} clients=${room.sockets.size}`,
    );
  }
}, STATUS_MS);

// Shutdown: flush every room synchronously (autosave debounce may not have fired), then close + exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[headless-host] ${signal} — flushing ${rooms.size} room(s) to disk`);
  clearInterval(tickTimer);
  clearInterval(statusTimer);
  for (const room of rooms.values()) {
    if (room.saveTimer !== undefined) clearTimeout(room.saveTimer);
    saveNow(room);
    room.disposeOutbound?.();
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref(); // don't hang if sockets linger
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * @typedef {Object} Room
 * @property {string} name
 * @property {import("loro-crdt").LoroDoc} doc
 * @property {ReturnType<typeof createDurableStore>} store
 * @property {ReturnType<typeof createWorld>} world
 * @property {any[]} [pipeline]
 * @property {Set<any>} sockets
 * @property {ReturnType<typeof setTimeout>|undefined} saveTimer
 * @property {boolean} [dead]
 * @property {(() => void)|undefined} disposeOutbound
 */
