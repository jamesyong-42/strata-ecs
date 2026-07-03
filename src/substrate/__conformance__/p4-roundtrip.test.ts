/**
 * P4 — export → import identity (Patch Note 005 §8, §1.1).
 *
 * `world.export()` → `import` into a fresh world reproduces the document UP TO HANDLE RENAMING,
 * including DANGLING `eid`/`key` references (a dangling ref round-trips as dangling — `null` for eid,
 * the same opaque string for key — never a crash). Randomized worlds are built from the same PRNG +
 * schema + awkward-value machinery as the ladder suite, anchored by a per-entity `CUid` so the model
 * compares topology through stable identities rather than renamed handles (the `fuzz-snapshot`
 * convention, enriched).
 *
 * JSON NUANCE (documented limitation, pinned in snapshot.stress.ts): the LOCAL snapshot serializes
 * through JSON, which cannot carry `NaN`/`±Infinity` (→ `null`) or signed zero. So P4 draws FINITE,
 * JSON-safe awkward values — 0.1-style floats (f32 `fround` still under test), wrapping integers
 * (300 → u8 = 44), control-char strings, enum labels, missing-optional fields — while the FULL
 * awkward set (NaN/-0/±Inf) is exercised by P1 on the ladder, which never JSON-serializes.
 */

import { describe, expect, it } from "vitest";
import { createWorld, type World } from "../../core/world";
import type { Entity } from "../../core/entity";
import type { ComponentEntry } from "../../core/runtime-store";
import {
  CFlag,
  CHealth,
  CLink,
  CMode,
  CName,
  CPos,
  CRef,
  CTile,
  CUid,
  RChild,
  RParent,
  TLock,
  TSel,
  mulberry32,
  pick,
  randInt,
  type Rng,
} from "./harness";

const JSON_FLOATS = [0, 0.1, 0.2, -0.5, 1.5, 3.14159, 42, -7, 100.25] as const; // finite: survive JSON
const JSON_INTS = [0, 1, 127, 128, 255, 256, 300, 65535, 70000] as const; // wrap under the column
const JSON_STRINGS = ["", "a", "hello", "x\ty", "", "unit"] as const; // no lone surrogates

/** Spawn-phase components (no eid — eid refs are wired in phase 2 once every target exists). */
function phase1Components(rng: Rng, uid: number): ComponentEntry[] {
  const comps: ComponentEntry[] = [[CUid, { n: uid }]];
  if (rng() < 0.8) comps.push([CPos, { x: pick(rng, JSON_FLOATS), y: pick(rng, JSON_FLOATS) }]);
  if (rng() < 0.6) comps.push([CTile, { u: pick(rng, JSON_INTS), i: pick(rng, JSON_INTS) }]);
  if (rng() < 0.4) comps.push([CFlag, { on: rng() < 0.5 }]);
  if (rng() < 0.5) comps.push([CName, { label: pick(rng, JSON_STRINGS) }]);
  if (rng() < 0.5) comps.push([CMode, { kind: pick(rng, ["idle", "run", "stop"]) }]);
  // key field: live-ish key, dangling "ghost", or null — all round-trip as the same opaque string.
  if (rng() < 0.5) comps.push([CLink, { to: rng() < 0.3 ? null : rng() < 0.5 ? `ghost${randInt(rng, 5)}` : `uid${randInt(rng, 20)}` }]);
  if (rng() < 0.4) comps.push([CHealth, rng() < 0.5 ? { hp: pick(rng, JSON_INTS) } : { hp: pick(rng, JSON_INTS), max: pick(rng, JSON_INTS) }]);
  return comps;
}

/** A random world with CUid anchors, awkward values, relations, and dangling eid/key refs. */
function randomWorld(rng: Rng, n: number): World {
  const w = createWorld();
  const handles: Entity[] = [];
  // Phase 1 — spawn every entity (CUid + non-eid components + tags).
  for (let i = 0; i < n; i++) {
    const tags = [];
    if (rng() < 0.4) tags.push(TSel);
    if (rng() < 0.3) tags.push(TLock);
    handles.push(w.runtime.spawn({ components: phase1Components(rng, i), tags }));
  }
  // Phase 2 — eid refs (CRef) + relations, now that every target exists.
  for (let i = 0; i < n; i++) {
    const h = handles[i];
    if (rng() < 0.5) w.addComponent(h, CRef, { target: handles[randInt(rng, n)] }); // may later dangle
    if (rng() < 0.4) w.setRelation(h, RParent, handles[randInt(rng, n)]);
    const kids = randInt(rng, 3);
    for (let j = 0; j < kids; j++) w.addRelation(h, RChild, handles[randInt(rng, n)]);
  }
  // Destroy a random subset — turns some eid refs / relation targets dangling (P4's crux).
  for (let i = 0; i < n; i++) {
    if (rng() < 0.25) w.destroy(handles[i]);
  }
  return w;
}

/** A uid-keyed topology model: eid → target uid or null (dangling); relations → target uids. */
function snapshotModel(w: World): Map<number, unknown> {
  const rt = w.runtime;
  const uidOf = new Map<Entity, number>();
  for (const e of rt.placedEntities()) uidOf.set(e, (w.read(e, CUid) as { n: number }).n);

  const out = new Map<number, unknown>();
  for (const e of rt.placedEntities()) {
    const components: Record<string, unknown> = {};
    for (const c of rt.componentsOf(e)) {
      if (c.name === CUid.name) continue; // the anchor is identity, not compared payload
      if (c.name === CRef.name) {
        const raw = (w.read(e, CRef) as { target: Entity }).target;
        components[CRef.name] = { target: uidOf.get(raw) ?? null }; // dangling eid → null on BOTH sides
      } else {
        components[c.name] = w.read(e, c);
      }
    }
    const tags = rt
      .tagsOf(e)
      .map((t) => t.name)
      .sort();
    const relations: Record<string, unknown> = {};
    const par = w.getRelation(e, RParent);
    if (par !== undefined) relations[RParent.name] = uidOf.get(par);
    const kids = w
      .getRelations(e, RChild)
      .map((h) => uidOf.get(h))
      .sort();
    if (kids.length > 0) relations[RChild.name] = kids;
    out.set(uidOf.get(e) as number, { components, tags, relations });
  }
  return out;
}

describe("P4 — export→import identity, incl. dangling eid/key (§8)", () => {
  for (const seed of [3, 17, 99, 512, 31337]) {
    it(`round-trips a random world up to handle renaming (seed ${seed})`, () => {
      const rng: Rng = mulberry32(seed);
      const w1 = randomWorld(rng, 20);

      const bytes = w1.export();
      const w2 = createWorld();
      expect(() => w2.import(bytes)).not.toThrow(); // dangling refs never crash the load

      expect(snapshotModel(w2)).toEqual(snapshotModel(w1));
    });
  }
});
