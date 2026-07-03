/**
 * The M4 conformance harness (Patch Note 005 §8) — the shared op interpreter that gates Part III.
 *
 * A bounded random op sequence is applied SIMULTANEOUSLY to:
 *   (a) the store-under-test, through the {@link MutableSnapshot} ladder (here `BaselineSnapshot`;
 *       Part III's `LoroSnapshot` reuses the IDENTICAL suite — see {@link "./runConformance"}), and
 *   (b) a real `RuntimeStore` ORACLE, driven through the {@link Projector} projection primitives,
 *       via the projector's key↔handle bijection.
 * The two are then compared cell-by-cell ({@link assertEquivalent}) — the P1 law.
 *
 * The schema is process-global (schema.ts), so it is defined ONCE here with distinctive `CFM…`
 * names and shared across every property file (each `*.test.ts` is a separate Vitest module graph,
 * so the module — and its schema — evaluates once per file, exactly the `__stress__/reference.ts`
 * convention; no `__resetSchemaForTesting` is needed because we never re-declare within a file).
 *
 * The generator produces AWKWARD values on purpose (§8): 0.1-style non-f32-exact floats, NaN, -0,
 * ±Infinity, out-of-range integers (300 → u8 wraps to 44), enum labels, strings (incl. the
 * normalize cell-key separator ), key fields (live + dangling + null), and missing-optional
 * (has-default) fields.
 *
 * RESOURCE NUANCE (M2 / §2, §7): resources are OBJECT-backed — `RuntimeStore.setResource` stores the
 * raw defaults-filled object with NO typed-array round-trip. So resource cells compare under
 * `canonResource` semantics (raw), NOT column-coerced `canon`; the baseline stores `canonResource`
 * too, so both sides hold the same raw object and {@link cellEquals} agrees. Components use full
 * `canon` (they DO round-trip a column).
 *
 * EXISTENCE MODEL (E5, §4.1): {@link diffViews} asserts `hasEntity` equivalence after every op. The
 * shared definition is the baseline's DERIVED liveness — a key exists iff it was spawned-and-not-
 * despawned OR it currently holds any cell ("a component/tag/relation write implies existence"). With
 * spawn now existence-only (§4.1), the baseline's spawned-until-despawn matches the runtime's
 * alive-until-destroy. ONE residual asymmetry is unprobeable on the runtime: a spawned-but-empty
 * entity and a cell-emptied one BOTH sit placed in the empty archetype, indistinguishable by any
 * runtime read. So {@link RuntimeOracle} tracks an explicit `spawnedKeys` mirror for exactly that bit
 * and computes `hasEntity` under the same derived model; everything else (cells, placement) is probed
 * from the real runtime.
 */

import { type EntityKey, entityKey, field, enumOf, isEnumType } from "../../core/field";
import {
  type Component,
  type FieldMeta,
  type Relation,
  type Resource,
  type Tag,
  defineComponent,
  defineRelation,
  defineResource,
  defineTag,
} from "../../core/schema";
import { RuntimeStore } from "../../core/runtime-store";
import type { Entity } from "../../core/entity";
import { createWorld, type World } from "../../core/world";
import { Projector } from "../projector";
import { cellEquals } from "../canon";
import type { ChangeEvent, ComponentValue, MutableSnapshot, Origin } from "../types";

// ---------------------------------------------------------------------------
// The process-global conformance schema — declared ONCE (§8; see file header)
// ---------------------------------------------------------------------------

/** f32 column: exercises 0.1/NaN/-0/±Inf canon coercion (`Math.fround`, §2.4). */
export const CPos = defineComponent("CFMPos", { x: "f32", y: "f32" });
/** integer columns: exercise modular wrap (300 → u8 = 44; -1 → u8 = 255), never clamp (§2.4). */
export const CTile = defineComponent("CFMTile", { u: "u8", i: "i16" });
export const CFlag = defineComponent("CFMFlag", { on: "bool" });
export const CName = defineComponent("CFMName", { label: "string" });
/** enum column: valid labels only (canon THROWS on an unknown label — that reject path is tryCanon's, §2.3). */
export const CMode = defineComponent("CFMMode", { kind: enumOf(["idle", "run", "stop"]) });
/** `key` field: the entity reference form on the wire (§7). Round-trips as a plain string — a dangling ref is harmless. */
export const CLink = defineComponent("CFMLink", { to: "key" });
/** has-default field: sometimes omitted → default-filled by canon, identical on both sides (§2.3). */
export const CHealth = defineComponent("CFMHealth", { hp: "u8", max: field("u8", { default: 100 }) });

export const TSel = defineTag("CFMSel");
export const TLock = defineTag("CFMLock");

export const RParent = defineRelation("CFMParent", { arity: "one" });
export const RChild = defineRelation("CFMChild", { arity: "many" });

/** f32 resource field: canonResource keeps it RAW (no fround) — the M2 resource nuance (§2, §7). */
export const RCam = defineResource("CFMCam", { zoom: "f32", mode: field("u8", { default: 1 }) });
export const RGrid = defineResource("CFMGrid", { size: "u16" });

// P4-only. §7 forbids `eid` on the ladder wire, so the interpreter NEVER emits these; they exist for
// the local-snapshot (world.export/import) round-trip, which does remap eid through its dense-id table.
export const CRef = defineComponent("CFMRef", { target: "eid" });
export const CUid = defineComponent("CFMUid", { n: "u32" });

/** The schema surface the interpreter randomizes over (ladder-legal: no `eid` fields, §7). */
export interface Schema {
  readonly components: readonly Component[];
  readonly tags: readonly Tag[];
  readonly relOne: readonly Relation[];
  readonly relMany: readonly Relation[];
  readonly resources: readonly Resource[];
}

export const SCHEMA: Schema = {
  components: [CPos, CTile, CFlag, CName, CMode, CLink, CHealth],
  tags: [TSel, TLock],
  relOne: [RParent],
  relMany: [RChild],
  resources: [RCam, RGrid],
};

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — replayable failures from a fixed seed (§8)
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** mulberry32 — the same tiny PRNG `__stress__/harness.ts` uses. `seed >>> 0`, returns `[0, 1)`. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}
export function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[randInt(rng, xs.length)];
}

/** Build the fixed key pool `["cfm0", …]` — the peer-prefixed opaque strings the ladder is keyed by. */
export function keyPool(n: number): EntityKey[] {
  const out: EntityKey[] = [];
  for (let i = 0; i < n; i++) out.push(entityKey(`cfm${i}`));
  // Hostile keys (§E3): a peer-controlled EntityKey may embed the OLD cell-key separator (U+001F) or the
  // literal '*' slot sentinel. Fold a couple in so the whole suite proves the collision-proof cell-key
  // encoding (normalize.ts) never conflates them with a real cell.
  out.push(entityKey(`cfm${String.fromCharCode(31)}x`), entityKey("*"));
  return out;
}

// ---------------------------------------------------------------------------
// Awkward value generators (§8) — every value is canon-VALID (canon throws on
// malformation; the reject path is canon.test.ts's tryCanon, not the interpreter's)
// ---------------------------------------------------------------------------

const AWKWARD_FLOATS = [0, -0, 0.1, 0.2, -0.5, 1.5, 3.14159, 1e20, -1e20, NaN, Infinity, -Infinity, 42, -7] as const;
// Finite on purpose: a NaN/±Inf into an INTEGER column silently coerces to 0 on BOTH sides (consistent),
// but keeping integers finite makes the wrap (300→44, -1→255) the thing under test, not the 0-collapse.
const AWKWARD_INTS = [0, 1, -1, 127, 128, 255, 256, 300, -128, 32767, 65535, 70000, -1000] as const;
const AWKWARD_STRINGS = ["", "a", "hello", "0", " ", "x\ty", "", "zzz"] as const; //  = normalize SEP

function genFieldValue(rng: Rng, f: FieldMeta, keys: readonly EntityKey[]): unknown {
  const type = f.spec.type;
  if (isEnumType(type)) return pick(rng, [...type.labelToDisc.keys()]);
  switch (type) {
    case "bool":
      return rng() < 0.5;
    case "string":
      return pick(rng, AWKWARD_STRINGS);
    case "key": {
      const r = rng();
      if (r < 0.2) return null; // key columns are nullable (field.ts)
      if (r < 0.5) return `ghost${randInt(rng, 5)}`; // a DANGLING key ref — round-trips as a string (§7)
      return pick(rng, keys); // a possibly-live key
    }
    case "f32":
    case "f64":
      return pick(rng, AWKWARD_FLOATS);
    default:
      return pick(rng, AWKWARD_INTS); // integer columns wrap
  }
}

/** A canon-valid component value; a has-default field is sometimes OMITTED → default-fill (§8). */
export function genComponentValue(rng: Rng, c: Component, keys: readonly EntityKey[]): ComponentValue {
  const v: ComponentValue = {};
  for (const f of c.fields) {
    if (f.spec.hasDefault && rng() < 0.3) continue; // missing-optional → default-filled by canon (§2.3)
    v[f.name] = genFieldValue(rng, f, keys);
  }
  return v;
}

export function genResourceValue(rng: Rng, res: Resource, keys: readonly EntityKey[]): ComponentValue {
  const v: ComponentValue = {};
  for (const f of res.fields) {
    if (f.spec.hasDefault && rng() < 0.3) continue;
    v[f.name] = genFieldValue(rng, f, keys);
  }
  return v;
}

// ---------------------------------------------------------------------------
// The op vocabulary — mirrors MutableSnapshot's cell-addressed writes (§1.2)
// ---------------------------------------------------------------------------

export type Op =
  | { t: "spawn"; k: EntityKey }
  | { t: "despawn"; k: EntityKey }
  | { t: "setC"; k: EntityKey; c: Component; v: ComponentValue }
  | { t: "rmC"; k: EntityKey; c: Component }
  | { t: "addTag"; k: EntityKey; tag: Tag }
  | { t: "rmTag"; k: EntityKey; tag: Tag }
  | { t: "setRel"; k: EntityKey; r: Relation; tk: EntityKey } // arity "one"
  | { t: "addRel"; k: EntityKey; r: Relation; tk: EntityKey } // arity "many"
  | { t: "rmRel"; k: EntityKey; r: Relation; tk?: EntityKey }
  | { t: "setRes"; res: Resource; v: ComponentValue }
  | { t: "rmRes"; res: Resource };

export interface GenConfig {
  readonly keys: readonly EntityKey[];
  readonly opCount: number;
}

const OP_WEIGHTS: ReadonlyArray<readonly [Op["t"], number]> = [
  ["spawn", 2],
  ["despawn", 1],
  ["setC", 4],
  ["rmC", 1],
  ["addTag", 2],
  ["rmTag", 1],
  ["setRel", 2],
  ["addRel", 2],
  ["rmRel", 1],
  ["setRes", 1],
  ["rmRes", 1],
];
const OP_WEIGHT_TOTAL = OP_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function pickKind(rng: Rng): Op["t"] {
  let r = rng() * OP_WEIGHT_TOTAL;
  for (const [kind, w] of OP_WEIGHTS) {
    if ((r -= w) < 0) return kind;
  }
  return "setC";
}

/**
 * A random op sequence for the dual interpreter (P1/P2) — NO liveness guard. Since `BaselineSnapshot.spawn`
 * is now EXISTENCE-ONLY (it clears nothing, §4.1), it agrees with the projector's `applySpawn`
 * (`ensurePlaced`, also non-clearing) on EVERY key — live or not. So `spawn` is emitted freely and the
 * previously-fenced spawn-on-live window IS exercised (respawn, spawn-over-cells, remove-then-set,
 * dangling relation targets, target-less removes all flow with no special-casing). The old guard
 * existed only because the pre-fix `spawn` wiped cells; that divergence is gone.
 */
export function genOps(rng: Rng, cfg: GenConfig): Op[] {
  const keys = cfg.keys;
  const ops: Op[] = [];
  for (let i = 0; i < cfg.opCount; i++) {
    const k = pick(rng, keys);
    switch (pickKind(rng)) {
      case "spawn":
        ops.push({ t: "spawn", k });
        break;
      case "despawn":
        ops.push({ t: "despawn", k });
        break;
      case "setC": {
        const c = pick(rng, SCHEMA.components);
        ops.push({ t: "setC", k, c, v: genComponentValue(rng, c, keys) });
        break;
      }
      case "rmC":
        ops.push({ t: "rmC", k, c: pick(rng, SCHEMA.components) });
        break;
      case "addTag":
        ops.push({ t: "addTag", k, tag: pick(rng, SCHEMA.tags) });
        break;
      case "rmTag":
        ops.push({ t: "rmTag", k, tag: pick(rng, SCHEMA.tags) });
        break;
      case "setRel":
        ops.push({ t: "setRel", k, r: pick(rng, SCHEMA.relOne), tk: pick(rng, keys) });
        break;
      case "addRel":
        ops.push({ t: "addRel", k, r: pick(rng, SCHEMA.relMany), tk: pick(rng, keys) });
        break;
      case "rmRel": {
        const r = pick(rng, rng() < 0.5 ? SCHEMA.relOne : SCHEMA.relMany);
        ops.push({ t: "rmRel", k, r, tk: rng() < 0.5 ? pick(rng, keys) : undefined }); // target-less half the time
        break;
      }
      case "setRes": {
        const res = pick(rng, SCHEMA.resources);
        ops.push({ t: "setRes", res, v: genResourceValue(rng, res, keys) });
        break;
      }
      case "rmRes":
        ops.push({ t: "rmRes", res: pick(rng, SCHEMA.resources) });
        break;
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Applying one op to the ladder (store-under-test) and to the runtime oracle
// ---------------------------------------------------------------------------

/** Apply an op to a `MutableSnapshot` — the store-under-test side of the interpreter (§1.2). */
export function applyToStore(store: MutableSnapshot, op: Op): void {
  switch (op.t) {
    case "spawn": return store.spawn(op.k);
    case "despawn": return store.despawn(op.k);
    case "setC": return store.setComponent(op.k, op.c, op.v);
    case "rmC": return store.removeComponent(op.k, op.c);
    case "addTag": return store.addTag(op.k, op.tag);
    case "rmTag": return store.removeTag(op.k, op.tag);
    case "setRel": return store.setRelation(op.k, op.r, op.tk);
    case "addRel": return store.addRelation(op.k, op.r, op.tk);
    case "rmRel": return store.removeRelation(op.k, op.r, op.tk);
    case "setRes": return store.setResource(op.res, op.v);
    case "rmRes": return store.removeResource(op.res);
  }
}

/**
 * The real-`RuntimeStore` oracle, driven through the {@link Projector} exactly as the durable seam
 * will drive it (§5.2). Resource facts land on `RuntimeStore` DIRECTLY (§6.1 — the projector owns no
 * resource path). Reads map back through the projector's non-minting {@link Projector.handleFor}
 * peek, so an untouched key reads `undefined`/empty without minting a phantom identity.
 */
export class RuntimeOracle {
  readonly world: World = createWorld();
  readonly rt: RuntimeStore;
  readonly proj: Projector;
  private counter = 0;
  /**
   * Explicit-spawn mirror (§4.1, E5). The runtime CANNOT distinguish a spawned-but-empty entity
   * (`applySpawn` → placed in the empty archetype) from a cell-emptied one (all components removed →
   * also placed in the empty archetype). The baseline's derived liveness DOES (`spawned` OR holds a
   * cell). So the oracle tracks the spawn intent here to compute `hasEntity` under the SAME derived
   * model — the only part of existence a runtime probe can't recover.
   */
  private readonly spawnedKeys = new Set<EntityKey>();

  constructor() {
    this.rt = this.world.runtime;
    // A monotonic key minter — never collides with the interpreter's `cfmN` pool (own-spawn keys only).
    this.proj = new Projector(this.rt, () => entityKey(`orc${this.counter++}`));
  }

  apply(op: Op): void {
    const p = this.proj;
    switch (op.t) {
      case "spawn": this.spawnedKeys.add(op.k); return p.applySpawn(op.k);
      case "despawn": this.spawnedKeys.delete(op.k); return p.remove(op.k);
      case "setC": return p.applyComponent(op.k, op.c, op.v);
      case "rmC": return p.removeComponent(op.k, op.c);
      case "addTag": return p.applyTag(op.k, op.tag);
      case "rmTag": return p.removeTag(op.k, op.tag);
      case "setRel": return p.applyRelationSet(op.k, op.r, op.tk);
      case "addRel": return p.applyRelationAdd(op.k, op.r, op.tk);
      case "rmRel": return p.removeRelation(op.k, op.r, op.tk);
      case "setRes": return void this.rt.setResource(op.res, op.v);
      case "rmRes": return void this.rt.removeResource(op.res);
    }
  }

  // The SnapshotView (read subset) — mapped from handles back to keys via the bijection peeks.

  /**
   * Existence under the baseline's derived-liveness model (E5): the key exists iff its handle is bound
   * and alive AND (it was explicitly spawned-and-not-despawned OR it holds any cell). This is
   * "a component/tag/relation write implies existence" applied to BOTH sides — a cell write makes the
   * entity exist while the cell is held; a spawn makes it exist until despawn. `isPlaced` is implicit:
   * an identity-only relation TARGET holds no cell here and is not in `spawnedKeys`, so it reads absent,
   * matching the baseline (a reverse-only key is not live).
   */
  hasEntity(k: EntityKey): boolean {
    const h = this.proj.handleFor(k);
    if (h === undefined || !this.rt.isAlive(h)) return false;
    return this.spawnedKeys.has(k) || this.hasAnyRuntimeCell(h);
  }

  private hasAnyRuntimeCell(h: Entity): boolean {
    for (const c of SCHEMA.components) if (this.rt.has(h, c)) return true;
    for (const t of SCHEMA.tags) if (this.rt.hasTag(h, t)) return true;
    for (const r of SCHEMA.relOne) if (this.rt.getRelation(h, r) !== undefined) return true;
    for (const r of SCHEMA.relMany) if (this.rt.getRelations(h, r).length > 0) return true;
    return false;
  }

  getComponent(k: EntityKey, c: Component): ComponentValue | undefined {
    const h = this.proj.handleFor(k);
    return h === undefined ? undefined : (this.rt.get(h, c) as ComponentValue | undefined);
  }
  hasTag(k: EntityKey, t: Tag): boolean {
    const h = this.proj.handleFor(k);
    return h === undefined ? false : this.rt.hasTag(h, t);
  }
  getRelationOne(k: EntityKey, r: Relation): EntityKey | undefined {
    const h = this.proj.handleFor(k);
    if (h === undefined) return undefined;
    const target = this.rt.getRelation(h, r); // VALIDATED — a dead target reads undefined
    return target === undefined ? undefined : this.proj.keyFor(target);
  }
  getRelationMany(k: EntityKey, r: Relation): EntityKey[] {
    const h = this.proj.handleFor(k);
    if (h === undefined) return [];
    const out: EntityKey[] = [];
    for (const target of this.rt.getRelations(h, r)) {
      const tk = this.proj.keyFor(target); // every projected target is bound
      if (tk !== undefined) out.push(tk);
    }
    return out;
  }
  getResource(res: Resource): ComponentValue | undefined {
    return this.rt.getResource(res) as ComponentValue | undefined;
  }
}

// ---------------------------------------------------------------------------
// Comparators — the P1 cell-equivalence law and the P2 incoming-edge scan
// ---------------------------------------------------------------------------

/** The read subset both the ladder and the oracle satisfy — the surface the comparators compare. */
export interface SnapshotView {
  hasEntity(k: EntityKey): boolean;
  getComponent(k: EntityKey, c: Component): ComponentValue | undefined;
  hasTag(k: EntityKey, t: Tag): boolean;
  getRelationOne(k: EntityKey, r: Relation): EntityKey | undefined;
  getRelationMany(k: EntityKey, r: Relation): EntityKey[];
  getResource(res: Resource): ComponentValue | undefined;
}

function sameKeySet(a: readonly EntityKey[], b: readonly EntityKey[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const k of b) if (!s.has(k)) return false;
  return true;
}

/**
 * The P1 law: after every op, the two views agree on EVERY cell over the key pool — components by
 * full-`canon` {@link cellEquals}, tags, arity-split relations (compared as sets of keys), and
 * resources by `canonResource` `cellEquals`. Returns `null` on agreement or a human string naming the
 * first divergent cell (so a failure points straight at the offending (key, cell)).
 */
export function diffViews(a: SnapshotView, b: SnapshotView, keys: readonly EntityKey[], schema: Schema): string | null {
  for (const k of keys) {
    if (a.hasEntity(k) !== b.hasEntity(k)) {
      return `existence of ${k}: ${a.hasEntity(k)} vs ${b.hasEntity(k)}`; // the E5 existence-equivalence law
    }
    for (const c of schema.components) {
      const av = a.getComponent(k, c);
      const bv = b.getComponent(k, c);
      if (!cellEquals(av, bv)) return `component ${c.name} on ${k}: ${JSON.stringify(av)} vs ${JSON.stringify(bv)}`;
    }
    for (const t of schema.tags) {
      if (a.hasTag(k, t) !== b.hasTag(k, t)) return `tag ${t.name} on ${k}: ${a.hasTag(k, t)} vs ${b.hasTag(k, t)}`;
    }
    for (const r of schema.relOne) {
      if (a.getRelationOne(k, r) !== b.getRelationOne(k, r)) {
        return `relation-one ${r.name} on ${k}: ${a.getRelationOne(k, r)} vs ${b.getRelationOne(k, r)}`;
      }
    }
    for (const r of schema.relMany) {
      if (!sameKeySet(a.getRelationMany(k, r), b.getRelationMany(k, r))) {
        return `relation-many ${r.name} on ${k}: ${JSON.stringify(a.getRelationMany(k, r))} vs ${JSON.stringify(b.getRelationMany(k, r))}`;
      }
    }
  }
  for (const res of schema.resources) {
    if (!cellEquals(a.getResource(res), b.getResource(res))) {
      return `resource ${res.name}: ${JSON.stringify(a.getResource(res))} vs ${JSON.stringify(b.getResource(res))}`;
    }
  }
  return null;
}

/**
 * The P2 scan (§1.3 three-part despawn): after `despawn(k)`, NO incoming edge to `k` survives
 * anywhere — scan every OTHER key's relations, both arities. Generic over the read view, so it runs
 * on the ladder (the property) AND the oracle (the agreement). Returns the offending source key or null.
 */
export function findIncoming(view: SnapshotView, k: EntityKey, keys: readonly EntityKey[], schema: Schema): EntityKey | null {
  for (const j of keys) {
    if (j === k) continue;
    for (const r of schema.relOne) if (view.getRelationOne(j, r) === k) return j;
    for (const r of schema.relMany) if (view.getRelationMany(j, r).includes(k)) return j;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ChangeEvent generation — for P5 (normalizeBatch ≡ raw apply, §4.3)
// ---------------------------------------------------------------------------

/**
 * A random `ChangeEvent[]` over the key pool — ARBITRARY order, no liveness guard. P5's acceptance
 * oracle holds for ANY event list (that is the point: `normalizeBatch`'s despawn-dominance /
 * respawn-fresh / last-fact-wins reproduces the baseline's own apply semantics), so this deliberately
 * emits despawn-before-spawn, spawn→mutate→despawn, despawn→respawn, remove-then-set, target-less
 * removes, arity-one vs -many facts, and resource facts. Values are canon-VALID and relation arity is
 * respected (else `setComponent`/`setRelation` throw identically on both sides — a wash, not a bug).
 * Origin is cosmetic here (`normalizeBatch` ignores it).
 */
export function genEvents(rng: Rng, cfg: GenConfig, origin: Origin = "local"): ChangeEvent[] {
  const keys = cfg.keys;
  const events: ChangeEvent[] = [];
  for (let i = 0; i < cfg.opCount; i++) {
    const key = pick(rng, keys);
    switch (pickKind(rng)) {
      case "spawn": events.push({ kind: "spawn", key, origin }); break;
      case "despawn": events.push({ kind: "despawn", key, origin }); break;
      case "setC": {
        const comp = pick(rng, SCHEMA.components);
        events.push({ kind: "component-set", key, comp, value: genComponentValue(rng, comp, keys), origin });
        break;
      }
      case "rmC": events.push({ kind: "component-remove", key, comp: pick(rng, SCHEMA.components), origin }); break;
      case "addTag": events.push({ kind: "tag-add", key, tag: pick(rng, SCHEMA.tags), origin }); break;
      case "rmTag": events.push({ kind: "tag-remove", key, tag: pick(rng, SCHEMA.tags), origin }); break;
      case "setRel": events.push({ kind: "relation-set", key, rel: pick(rng, SCHEMA.relOne), target: pick(rng, keys), origin }); break;
      case "addRel": events.push({ kind: "relation-add", key, rel: pick(rng, SCHEMA.relMany), target: pick(rng, keys), origin }); break;
      case "rmRel": {
        const rel = pick(rng, rng() < 0.5 ? SCHEMA.relOne : SCHEMA.relMany);
        events.push({ kind: "relation-remove", key, rel, target: rng() < 0.5 ? pick(rng, keys) : undefined, origin });
        break;
      }
      case "setRes": {
        const res = pick(rng, SCHEMA.resources);
        events.push({ kind: "resource-set", res, value: genResourceValue(rng, res, keys), origin });
        break;
      }
      case "rmRes": events.push({ kind: "resource-remove", res: pick(rng, SCHEMA.resources), origin }); break;
    }
  }
  return events;
}

/** Apply one `ChangeEvent` (doc-fact) to a `MutableSnapshot` — the P5 raw-apply path (§4.3). */
export function applyEvent(store: MutableSnapshot, e: ChangeEvent): void {
  switch (e.kind) {
    case "spawn": return store.spawn(e.key);
    case "despawn": return store.despawn(e.key);
    case "component-set": return store.setComponent(e.key, e.comp, e.value);
    case "component-remove": return store.removeComponent(e.key, e.comp);
    case "tag-add": return store.addTag(e.key, e.tag);
    case "tag-remove": return store.removeTag(e.key, e.tag);
    case "relation-set": return store.setRelation(e.key, e.rel, e.target);
    case "relation-add": return store.addRelation(e.key, e.rel, e.target);
    case "relation-remove": return store.removeRelation(e.key, e.rel, e.target);
    case "resource-set": return store.setResource(e.res, e.value);
    case "resource-remove": return store.removeResource(e.res);
  }
}

/** Full-state diff between two `MutableSnapshot`s (P5 compares normalized-apply vs raw-apply). Existence
 *  is compared inside {@link diffViews} (the E5 law), so this is just the cell-level delegate. */
export function diffStores(a: MutableSnapshot, b: MutableSnapshot, keys: readonly EntityKey[], schema: Schema): string | null {
  return diffViews(a, b, keys, schema);
}
