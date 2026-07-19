/**
 * A headless strata client — the same bytes seam as the browser demo, driven from Node.
 *
 * `createHeadlessClient(url)` builds a World + DurableStore, attaches them, opens a WebSocket to the host
 * (the room is the URL path, e.g. ws://localhost:8788/design), and runs the joiner half of the bootstrap:
 *
 *   1. on open → send `hello`
 *   2. inbound `snapshot` → import it (our causal base), mark bootstrapped, send our OWN `base` back
 *      (the bidirectional law), then drain any pre-bootstrap buffer
 *   3. inbound `base`/`update` → applyRemote (or buffer, if the snapshot has not landed yet)
 *   4. every local commit (`subscribeOutbound`) → send an `update` frame (queued until our base is sent)
 *
 * A joiner must NOT apply an increment before it holds the base (it would quarantine), so inbound frames
 * that arrive pre-bootstrap are BUFFERED and drained in arrival order once the snapshot lands (boot.ts).
 * `PendingImportError` anywhere means this document instance is permanently quarantined — the recovery is
 * to reconnect and re-bootstrap from scratch; here we surface it and close.
 *
 * Programmatic use: `const c = createHeadlessClient(url); await c.ready; c.store.transaction(tx => …)`.
 * The store is exposed for authoring; `c.digest()` and `c.sync()` are the convergence/inspection helpers.
 */

import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { LoroDoc } from "loro-crdt";
import { createWorld } from "@vibecook/strata-ecs";
import {
  attachDurable,
  createDurableStore,
  PendingImportError,
} from "@vibecook/strata-ecs/durable";
import { documentDigest, frame, KIND, unframe } from "./protocol.mjs";
// Importing the schema registers its components (process-global) so the client's projection resolves the
// document's component names into runtime columns. Any consumer of createHeadlessClient needs it loaded.
import { Pos, Tint } from "./schema.mjs";

const SYNC_HZ = 30;
const JOIN_TIMEOUT_MS = 10_000;

export function createHeadlessClient(url, { name = "client" } = {}) {
  const doc = new LoroDoc();
  const store = createDurableStore(doc);
  const world = createWorld({ name: `headless:${name}` });
  attachDurable(world, store);

  let bootstrapped = false;
  let baseSent = false;
  let quarantined = false;
  const inboundBuffer = []; // increments that arrived before our snapshot (drained on bootstrap)
  const outbox = []; // local commit bytes produced before our base is sent (flushed after)

  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";

  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const joinTimer = setTimeout(() => {
    if (!bootstrapped)
      rejectReady(
        new Error(`headless client "${name}" did not bootstrap within ${JOIN_TIMEOUT_MS}ms`),
      );
  }, JOIN_TIMEOUT_MS);
  joinTimer.unref?.();

  /**
   * applyRemote with a TOTAL failure guard: loro throws a bare string (not an Error) on undecodable
   * bytes, and a PendingImportError permanently quarantines this document instance — either way the
   * recovery is identical (reconnect = full re-bootstrap from a fresh doc), and neither may escape the
   * ws handler (one bad payload must never kill the process).
   */
  function applyRemote(bytes, what) {
    if (quarantined) return;
    try {
      store.applyRemote(bytes);
    } catch (err) {
      quarantined = true;
      const why = err instanceof PendingImportError ? "quarantined" : "undecodable bytes";
      console.warn(`[client:${name}] ${why} on ${what} — reconnect to re-bootstrap`);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      if (!bootstrapped) rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  ws.on("open", () => ws.send(frame(KIND.hello), { binary: true }));

  ws.on("message", (data) => {
    const { kind, payload } = unframe(data);
    if (kind === KIND.snapshot) {
      if (bootstrapped) return; // a redundant snapshot after bootstrap — ignore
      applyRemote(payload, "snapshot import");
      if (quarantined) return;
      bootstrapped = true;
      // Bidirectional law: hand the host our own base so our future increments never quarantine on it.
      ws.send(frame(KIND.base, store.exportSnapshot()), { binary: true });
      baseSent = true;
      for (const bytes of inboundBuffer) applyRemote(bytes, "buffered increment");
      inboundBuffer.length = 0;
      for (const bytes of outbox) ws.send(frame(KIND.update, bytes), { binary: true });
      outbox.length = 0;
      clearTimeout(joinTimer);
      resolveReady({ store, world });
      return;
    }
    // base (a peer's construction commit relayed by the host) and update are both just remote bytes.
    if (kind === KIND.base || kind === KIND.update) {
      if (bootstrapped) applyRemote(payload, kind === KIND.base ? "peer base" : "update");
      else inboundBuffer.push(payload); // never applyRemote an increment before the base lands
    }
  });

  ws.on("error", (err) => {
    if (!bootstrapped) rejectReady(err);
    else console.warn(`[client:${name}] socket error: ${err.message}`);
  });

  // OUTBOUND: each sealed local commit → an update frame (queued until our base has gone out).
  const disposeOutbound = store.subscribeOutbound((bytes) => {
    if (bootstrapped && baseSent && ws.readyState === WebSocket.OPEN) {
      ws.send(frame(KIND.update, bytes), { binary: true });
    } else {
      outbox.push(bytes);
    }
  });

  // A light sync loop so the runtime World reflects the converged document (queries, resources). The
  // convergence digest reads the document directly and does not depend on this.
  const syncTimer = setInterval(
    () => {
      try {
        world.sync();
      } catch {
        /* a mid-teardown sync is harmless */
      }
    },
    Math.round(1000 / SYNC_HZ),
  );
  syncTimer.unref?.();

  return {
    name,
    ready,
    store,
    world,
    /** Drain the inbound document into the runtime now (idempotent with the sync loop). */
    sync: () => world.sync(),
    /** `{ digest, entityCount }` over the converged document — compare across parties to prove convergence. */
    digest: () => documentDigest(store),
    isQuarantined: () => quarantined,
    close: () => {
      clearInterval(syncTimer);
      clearTimeout(joinTimer);
      disposeOutbound();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

// --- CLI: `node src/client.mjs ws://localhost:8788 <room>` ---------------------------------------------
// Joins the room, spawns a couple of entities through the transaction API, logs the converged room, exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? "ws://localhost:8788";
  const room = process.argv[3] ?? "cli-demo";
  const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;

  console.log(`[client:cli] joining ${url}`);
  const client = createHeadlessClient(url, { name: "cli" });
  await client.ready;
  console.log(
    `[client:cli] bootstrapped — room "${room}" has ${client.digest().entityCount} entities`,
  );

  // Spawn two entities, then (after a sync makes Pos pre-existing) nudge one — a real cross-transaction
  // value write, the §13.2 synchronous agreement path.
  const a = client.store.transaction((tx) =>
    tx.spawn({
      components: [
        [Pos, { x: 10, y: 20 }],
        [Tint, { hue: 200 }],
      ],
    }),
  );
  client.store.transaction((tx) =>
    tx.spawn({
      components: [
        [Pos, { x: 30, y: 40 }],
        [Tint, { hue: 40 }],
      ],
    }),
  );
  client.sync();
  client.store.transaction((tx) => tx.edit(a).set(Pos, { x: 11, y: 21 }));
  client.sync();

  const { digest, entityCount } = client.digest();
  console.log(
    `[client:cli] spawned 2 + edited 1 — room now ${entityCount} entities, digest=${digest}`,
  );
  // Give the last update a moment to reach the host before we go.
  await new Promise((r) => setTimeout(r, 250));
  client.close();
  console.log("[client:cli] done");
  process.exit(0);
}
