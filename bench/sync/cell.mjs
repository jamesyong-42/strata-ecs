/**
 * ONE benchmark cell — a single (variant × n) pair, measured in a FRESH node process.
 *
 * Isolation is the whole point. An earlier ad-hoc probe of this exact workload reported 4ms or
 * 128ms for the SAME scenario at the same size, reproducibly, depending only on whether a smaller
 * document had been processed earlier in the same process (wasm-heap/allocator state). Any harness
 * that sweeps sizes in one process measures that artifact instead of the workload. So: one process
 * per cell, and within the cell the cold rep is reported SEPARATELY from the warm ones rather than
 * averaged together — process-state dependence becomes a reported dimension instead of a silent bias.
 *
 *   node cell.mjs --variant steady_local --n 10000 --reps 5
 *   → SYNC_JSON:{"variant":"steady_local","n":10000,"ms":[...],"loro":"1.13.6",...}
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineComponent, entityKey } from "@vibecook/strata-ecs";
import { createDurableStore } from "@vibecook/strata-ecs/durable";

const require = createRequire(import.meta.url);
const STRATA_VERSION = require("@vibecook/strata-ecs/package.json").version;

// Resolve loro THROUGH strata's own resolution, never our own. loro-crdt is a wasm module with
// instance-identity checks (`expected instance of LoroDoc`), and strata's dist resolves its peer
// import from the package's own location — so a `loro-crdt` imported from here can silently be a
// DIFFERENT copy, and every call that hands a doc across the seam throws. Going through strata's
// require guarantees one instance, and makes the reported version the one actually under test.
const strataRequire = createRequire(require.resolve("@vibecook/strata-ecs/package.json"));
const LORO_VERSION = strataRequire("loro-crdt/package.json").version;
const { LoroDoc } = await import(pathToFileURL(strataRequire.resolve("loro-crdt")).href);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const VARIANT = arg("variant", "steady_pristine");
const N = Number(arg("n", 10_000));
const REPS = Number(arg("reps", 5));

const Pos = defineComponent("SyncBenchPos", { x: "f32", y: "f32" });
const Size = defineComponent("SyncBenchSize", { w: "f32", h: "f32" });

/** A sender holding an n-entity room. */
function makeSender() {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  const store = createDurableStore(doc);
  const s = store.snapshot;
  s.commit(() => {
    for (let i = 0; i < N; i++) {
      const k = entityKey(`1-${i}`);
      s.spawn(k);
      s.setComponent(k, Pos, { x: i, y: i });
      s.setComponent(k, Size, { w: 10, h: 10 });
    }
  });
  return s;
}

/** Read a cell straight from the doc — verification must not depend on the code under test. */
function readCell(doc, key, comp) {
  const child = doc.getMap("entities").get(key);
  return child === undefined ? undefined : child.get(`comp:${comp}`);
}

const now = () => performance.now();
const ms = [];
let verified = 0;
let deltaBytes = 0;
let snapshotBytes = 0;

for (let rep = 0; rep < REPS; rep++) {
  const sender = makeSender();
  // Re-export the base AFTER any prior commits so the receiver never joins behind the delta's
  // causal deps (doing otherwise quarantines the receiver — a real bug this harness must not hide).
  const base = sender.export();
  snapshotBytes = base.byteLength;

  const beforeEdit = sender.version();
  const target = entityKey(`1-${rep}`);
  sender.commit(() => sender.setComponent(target, Pos, { x: 900 + rep, y: 900 + rep }));
  const delta = sender.exportUpdatesSince(beforeEdit);
  deltaBytes = delta.byteLength;

  if (VARIANT === "bootstrap") {
    // A fresh joiner importing the whole room — the one-time join cost.
    const doc = new LoroDoc();
    doc.setPeerId(2 + rep);
    const store = createDurableStore(doc);
    const t0 = now();
    store.snapshot.applyRemote(base);
    ms.push(now() - t0);
    if (readCell(doc, `1-0`, "SyncBenchPos") !== undefined) verified++;
    continue;
  }

  if (VARIANT === "local_commit") {
    // A peer editing its OWN document — no remote traffic at all. `commit()` seals and then
    // flushLocal()s, which derives the local batch the same way applyRemote derives a remote one,
    // so this asks whether plain local editing is document-sized too.
    const doc = new LoroDoc();
    doc.setPeerId(2 + rep);
    const store = createDurableStore(doc);
    store.snapshot.applyRemote(base);
    const t0 = now();
    store.snapshot.commit(() => {
      store.snapshot.setComponent(entityKey(`1-${rep}`), Pos, { x: 777, y: 777 });
    });
    ms.push(now() - t0);
    const v = readCell(doc, entityKey(`1-${rep}`), "SyncBenchPos");
    if (v && v.x === 777) verified++;
    continue;
  }

  if (VARIANT === "bare_loro") {
    // Floor: plain loro applying the same delta, no strata in the path.
    const doc = new LoroDoc();
    doc.setPeerId(2 + rep);
    doc.import(base);
    const t0 = now();
    doc.import(delta);
    ms.push(now() - t0);
    const v = readCell(doc, target, "SyncBenchPos");
    if (v && v.x === 900 + rep) verified++;
    continue;
  }

  // steady_* : a receiver that already holds the room applies ONE small remote edit.
  const doc = new LoroDoc();
  doc.setPeerId(2 + rep);
  const store = createDurableStore(doc);
  store.snapshot.applyRemote(base);

  if (VARIANT === "steady_local") {
    // ...and has made its OWN edit — the real collaborative case (both peers editing).
    store.snapshot.commit(() => {
      store.snapshot.setComponent(entityKey(`1-${rep + 100}`), Pos, { x: 5, y: 5 });
    });
  }

  const t0 = now();
  store.snapshot.applyRemote(delta);
  ms.push(now() - t0);

  // Convergence check: the remote edit must actually be present, else we timed a no-op.
  const v = readCell(doc, target, "SyncBenchPos");
  if (v && v.x === 900 + rep) verified++;
}

process.stdout.write(
  "SYNC_JSON:" +
    JSON.stringify({
      variant: VARIANT,
      n: N,
      reps: REPS,
      ms,
      verified,
      deltaBytes,
      snapshotBytes,
      loro: LORO_VERSION,
      strata: STRATA_VERSION,
      node: process.version,
    }) +
    "\n",
);
