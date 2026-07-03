/**
 * Dev-only advisory pipeline access diagnostics (Patch Note 001 §3.3).
 *
 * v1 does NOT reorder systems — execution stays positional (§7.1) — so these checks never *fix* an
 * ordering, they *warn* about a manual order that looks data-inconsistent. Both are advisory
 * (`devWarn`, not `devError`): the author may have ordered deliberately. The whole surface compiles
 * out of production with `DEV`. This module is NOT called from `tick` here — the reactivity layer
 * (002) wires it in, gated on reactivity being active; it only exports the walker and the
 * read-default helper reactivity needs.
 */

import { DEV, devWarn } from "./dev";
import { type Component, type ComponentId, componentById } from "./schema";
import type { MemberCheck } from "./query";
import type { Pipeline, System } from "./system";

/**
 * The components a system reads (001 §2.3 read-default rule), materialized on demand.
 *
 * An explicit `access.read` wins verbatim. Otherwise the default is the query's positive component
 * membership — `required` plus every `Any(...)` group member (the columns the body may touch) —
 * minus anything already in `access.write` (a system reads what it queries unless it writes it).
 * `Not`/excluded components and tag/relation terms are never reads. Handles are recovered from the
 * compiled query's ids via the process-global registry (the compiled `Query` keeps ids, not
 * handles); an id with no live handle (e.g. after a schema reset) is skipped.
 *
 * A MIXED `Any(...)`/`All(...)` (with a tag or relation member) does NOT fold into
 * `anyComponentGroups` — it compiles to an `any` row filter whose `MemberCheck`s carry the component
 * members. Those are legal reads too, so they are walked here (adversarial-review fix); otherwise a
 * body reading a component that only appears inside a mixed `Any` would DEV-throw at `col()`.
 */
export function effectiveRead(system: System): Component[] {
  const access = system.access;
  if (access?.read !== undefined) return [...access.read];

  const writeIds = new Set<ComponentId>();
  if (access?.write !== undefined) for (const c of access.write) writeIds.add(c.id);

  const out: Component[] = [];
  const seen = new Set<ComponentId>();
  const add = (id: ComponentId): void => {
    if (writeIds.has(id) || seen.has(id)) return;
    seen.add(id);
    const c = componentById(id);
    if (c !== undefined) out.push(c);
  };
  const addMember = (m: MemberCheck): void => {
    if (m.kind === "component" && m.componentId !== undefined) add(m.componentId);
    else if (m.kind === "all" && m.members !== undefined) for (const mm of m.members) addMember(mm);
  };
  const q = system.query;
  for (const id of q.required) add(id);
  for (const group of q.anyComponentGroups) for (const id of group) add(id);
  for (const rf of q.rowFilters) {
    if (rf.kind === "any" && rf.members !== undefined) for (const m of rf.members) addMember(m);
  }
  return out;
}

/** Pipelines already walked — the walk runs once per pipeline object, so repeated ticks don't re-warn. */
const analyzed = new WeakSet<object>();

/**
 * Walk each phase's declared/default access and surface advisory dev warnings (001 §3.3):
 *
 * - two systems in one phase both writing the same component → a potential order-dependence;
 * - a system whose read set includes `C` positioned BEFORE a same-phase writer of `C` → a likely
 *   "reads stale `C`" bug.
 *
 * Advisory only — v1 never reorders (§7.1), so these help the author hand-order correctly rather
 * than taking ordering away. Runs its analysis once per pipeline object (dedup across repeated
 * ticks); a no-op in production.
 */
export function validatePipelineAccess(pipeline: Pipeline): void {
  if (!DEV) return;
  if (analyzed.has(pipeline)) return;
  analyzed.add(pipeline);

  for (const ph of pipeline) {
    const systems = ph.systems;
    // Per-component system positions within this phase; indices are pushed ascending (loop order),
    // so each writer list is sorted — `find(j > ri)` yields the earliest later writer.
    const writers = new Map<ComponentId, number[]>();
    const readers = new Map<ComponentId, number[]>();
    for (let i = 0; i < systems.length; i++) {
      const w = systems[i].access?.write;
      if (w !== undefined) for (const c of w) pushIndex(writers, c.id, i);
      for (const c of effectiveRead(systems[i])) pushIndex(readers, c.id, i);
    }

    // (a) same-phase double-writers → potential order-dependence.
    for (const [cid, widx] of writers) {
      if (widx.length < 2) continue;
      const names = widx.map((i) => `"${systems[i].name}"`).join(", ");
      devWarn(
        `access: in phase "${ph.name}", systems ${names} declare write of "${nameOf(cid)}" in the same phase — potential order-dependence (array order is execution order; order them deliberately or split the phase).`,
      );
    }

    // (b) a read positioned before a same-phase write of the same component → likely reads stale C.
    for (const [cid, ridx] of readers) {
      const widx = writers.get(cid);
      if (widx === undefined) continue;
      for (const ri of ridx) {
        const wi = widx.find((j) => j > ri);
        if (wi === undefined) continue;
        devWarn(
          `access: in phase "${ph.name}", system "${systems[ri].name}" reads "${nameOf(cid)}" before system "${systems[wi].name}" writes it — likely reads stale "${nameOf(cid)}"; consider reordering.`,
        );
      }
    }
  }
}

function pushIndex(m: Map<ComponentId, number[]>, id: ComponentId, i: number): void {
  const arr = m.get(id);
  if (arr === undefined) m.set(id, [i]);
  else arr.push(i);
}

function nameOf(id: ComponentId): string {
  return componentById(id)?.name ?? `component#${id}`;
}
