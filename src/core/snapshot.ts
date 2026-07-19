/**
 * Local snapshot — non-collaborative save/load (design §8).
 *
 * The runtime is the source of truth; a snapshot is a serialization of it. Entities are keyed by
 * a dense integer assigned at export time (NOT a document key — a single-writer file needs no
 * collision-free identity, §8). Components/tags/relations are stored by NAME (schema-derived, so
 * portable across runs); component values are the decoded, user-facing form (enum labels, real
 * strings). `eid` fields and relation edges are remapped through the dense-id table so
 * references between snapshot entities survive the round-trip.
 *
 * Loading is two-phase (§8.2): create every entity first, then resolve references — so a
 * reference target always exists before it is wired, with no ordering constraints on the list.
 */

import { type Entity, NULL_ENTITY } from "./entity";
import type { Component, Tag } from "./schema";
import {
  componentByName,
  relationById,
  relationByName,
  relationCount,
  resourceByName,
  tagByName,
} from "./schema";
import type { RuntimeStore } from "./runtime-store";
import type { ComponentEntry } from "./runtime-store";

const FORMAT_VERSION = 1;

interface EntityRecord {
  id: number;
  components: Record<string, Record<string, unknown>>;
  tags: string[];
  // arity "one" → scalar id; arity "many" → array of ids (§8.1: `RelName: id | [id, ...]`).
  relations: Record<string, number | number[]>;
}

export interface Snapshot {
  meta: { name: string; format_version: number };
  resources: Record<string, unknown>;
  entities: EntityRecord[];
  // Ordered relations only (plan-ordered-relations §3.5): relation name → parent snapshot id
  // (object key, so a numeric string) → child snapshot ids in sibling order. ADDITIVE — absent
  // on legacy snapshots and on worlds with no ordered sequences; import then falls back to the
  // deterministic completion order (ascending snapshot id).
  order?: Record<string, Record<string, number[]>>;
}

function hasEidField(c: Component): boolean {
  return c.fields.some((f) => f.spec.type === "eid");
}

/** Serialize the store's live state to bytes (§8). */
export function exportSnapshot(store: RuntimeStore, name: string): Uint8Array {
  const entities = store.placedEntities();
  const idOf = new Map<Entity, number>();
  entities.forEach((e, i) => idOf.set(e, i));

  const resources: Record<string, unknown> = {};
  for (const { resource, value } of store.resourceValues()) resources[resource.name] = value;

  const records: EntityRecord[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];

    const components: Record<string, Record<string, unknown>> = {};
    for (const c of store.componentsOf(e)) {
      let value = store.read(e, c) as Record<string, unknown>;
      if (hasEidField(c)) {
        value = { ...value };
        for (const f of c.fields) {
          if (f.spec.type === "eid") {
            const id = idOf.get(value[f.name] as Entity);
            value[f.name] = id !== undefined ? id : null; // dangling / out-of-snapshot → null
          }
        }
      }
      components[c.name] = value;
    }

    const tags = store.tagsOf(e).map((t) => t.name);

    const relations: Record<string, number | number[]> = {};
    for (const { relation, targets } of store.relationsOf(e)) {
      const ids: number[] = [];
      for (const t of targets) {
        const id = idOf.get(t);
        if (id !== undefined) ids.push(id);
      }
      if (ids.length > 0) relations[relation.name] = relation.arity === "one" ? ids[0] : ids;
    }

    records.push({ id: i, components, tags, relations });
  }

  // Ordered sibling sequences (§3.5) — one section per ordered relation with any sequence.
  // Unplaced parents/children are skipped, mirroring how their edges drop out of `relations`
  // above; entries are alive by construction (despawn splices eagerly).
  let order: Record<string, Record<string, number[]>> | undefined;
  for (let rid = 0; rid < relationCount(); rid++) {
    const rel = relationById(rid);
    if (rel === undefined || !rel.ordered) continue;
    let byParent: Record<string, number[]> | undefined;
    for (const [parent, children] of store.orderedEntriesOf(rel)) {
      const pid = idOf.get(parent);
      if (pid === undefined) continue;
      const ids: number[] = [];
      for (const c of children) {
        const cid = idOf.get(c);
        if (cid !== undefined) ids.push(cid);
      }
      if (ids.length === 0) continue;
      (byParent ??= {})[pid] = ids;
    }
    if (byParent !== undefined) (order ??= {})[rel.name] = byParent;
  }

  const snapshot: Snapshot = {
    meta: { name, format_version: FORMAT_VERSION },
    resources,
    entities: records,
    ...(order !== undefined ? { order } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

/**
 * Parse + validate a snapshot's envelope and schema references, WITHOUT mutating a store (§8.2).
 * Throws on an unsupported format version or any unknown component/tag/relation/resource name.
 * Split out so `world.import(bytes, { replace: true })` can validate BEFORE it resets — an
 * incompatible snapshot (schema drift) then leaves the world intact, so a failed document-open
 * never wipes the live board (the boot-quarantine + file-open failure UX both rely on this).
 */
export function parseSnapshot(bytes: Uint8Array): Snapshot {
  const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Snapshot;
  if (snapshot.meta?.format_version !== FORMAT_VERSION) {
    throw new Error(`strata: unsupported snapshot format version ${snapshot.meta?.format_version}.`);
  }
  for (const resName of Object.keys(snapshot.resources)) {
    if (resourceByName(resName) === undefined) throw new Error(`strata: snapshot references unknown resource "${resName}".`);
  }
  for (const record of snapshot.entities) {
    for (const cName of Object.keys(record.components)) {
      if (componentByName(cName) === undefined) throw new Error(`strata: snapshot references unknown component "${cName}".`);
    }
    for (const tName of record.tags) {
      if (tagByName(tName) === undefined) throw new Error(`strata: snapshot references unknown tag "${tName}".`);
    }
    for (const rName of Object.keys(record.relations)) {
      if (relationByName(rName) === undefined) throw new Error(`strata: snapshot references unknown relation "${rName}".`);
    }
  }
  // Order section (§3.5): SHAPE validation only, fail-closed before any reset — semantic
  // disagreements with the edges (stale/foreign entries) are D7-filtered at apply, never errors.
  if (snapshot.order !== undefined) {
    if (typeof snapshot.order !== "object" || snapshot.order === null || Array.isArray(snapshot.order)) {
      throw new Error("strata: snapshot order section is not an object.");
    }
    const ids = new Set(snapshot.entities.map((r) => r.id));
    for (const [rName, byParent] of Object.entries(snapshot.order)) {
      const rel = relationByName(rName);
      if (rel === undefined) throw new Error(`strata: snapshot order references unknown relation "${rName}".`);
      if (!rel.ordered) throw new Error(`strata: snapshot order references unordered relation "${rName}".`);
      if (typeof byParent !== "object" || byParent === null || Array.isArray(byParent)) {
        throw new Error(`strata: snapshot order for "${rName}" is not an object.`);
      }
      for (const [pid, children] of Object.entries(byParent)) {
        if (!ids.has(Number(pid))) throw new Error(`strata: snapshot order for "${rName}" names unknown parent ${pid}.`);
        if (!Array.isArray(children) || children.some((c) => typeof c !== "number" || !ids.has(c))) {
          throw new Error(`strata: snapshot order for "${rName}" parent ${pid} has a malformed child list.`);
        }
      }
    }
  }
  return snapshot;
}

/** Rebuild the store's state from bytes into an EMPTY store (§8.2). Throws on unknown schema names. */
export function importSnapshot(store: RuntimeStore, bytes: Uint8Array): void {
  if (store.liveCount() > 0) {
    throw new Error("strata: import() requires an empty world — create a fresh world to load a snapshot.");
  }
  applySnapshot(store, parseSnapshot(bytes));
}

/** Apply a parsed, validated snapshot into an EMPTY store (§8.2) — the mutating half of import. */
export function applySnapshot(store: RuntimeStore, snapshot: Snapshot): void {
  for (const [resName, value] of Object.entries(snapshot.resources)) {
    const res = resourceByName(resName);
    if (res === undefined) throw new Error(`strata: snapshot references unknown resource "${resName}".`);
    store.setResource(res, value);
  }

  // Phase 1 — create every entity (eid fields placeheld to null; resolved in phase 2).
  const handleOf = new Map<number, Entity>();
  const deferred: Array<{ handle: Entity; record: EntityRecord }> = [];
  for (const record of snapshot.entities) {
    const components: ComponentEntry[] = [];
    let needsEidResolve = false;
    for (const [cName, value] of Object.entries(record.components)) {
      const c = componentByName(cName);
      if (c === undefined) throw new Error(`strata: snapshot references unknown component "${cName}".`);
      if (hasEidField(c)) {
        needsEidResolve = true;
        const placeheld = { ...value };
        for (const f of c.fields) if (f.spec.type === "eid") placeheld[f.name] = NULL_ENTITY;
        components.push([c, placeheld]);
      } else {
        components.push([c, value]);
      }
    }
    const tags: Tag[] = [];
    for (const tName of record.tags) {
      const t = tagByName(tName);
      if (t === undefined) throw new Error(`strata: snapshot references unknown tag "${tName}".`);
      tags.push(t);
    }
    const handle = store.spawn({ components, tags });
    handleOf.set(record.id, handle);
    if (needsEidResolve || Object.keys(record.relations).length > 0) {
      deferred.push({ handle, record });
    }
  }

  // Phase 2 — resolve eid fields and relation edges now that every target exists.
  for (const { handle, record } of deferred) {
    for (const [cName, value] of Object.entries(record.components)) {
      const c = componentByName(cName);
      if (c === undefined || !hasEidField(c)) continue;
      const resolved = { ...value };
      for (const f of c.fields) {
        if (f.spec.type === "eid") {
          const id = value[f.name];
          resolved[f.name] = id === null || id === undefined ? NULL_ENTITY : (handleOf.get(id as number) ?? NULL_ENTITY);
        }
      }
      store.writeComponent(handle, c, resolved);
    }
    for (const [rName, raw] of Object.entries(record.relations)) {
      const rel = relationByName(rName);
      if (rel === undefined) throw new Error(`strata: snapshot references unknown relation "${rName}".`);
      const targetIds = Array.isArray(raw) ? raw : [raw]; // scalar (arity one) or array (many), §8.1
      for (const tid of targetIds) {
        const target = handleOf.get(tid);
        if (target === undefined) continue;
        if (rel.arity === "one") store.setRelation(handle, rel, target);
        else store.addRelation(handle, rel, target);
      }
    }
  }

  // Phase 3 — ordered sibling sequences, applied per D7 (plan-ordered-relations §3.5): keep the
  // section's entries that are LIVE CHILDREN of the parent (first occurrence wins), then append
  // every remaining child in ascending snapshot-id order. A legacy snapshot (no section) leaves
  // the phase-2 wiring order — records are imported in ascending id order, so that IS the
  // completion order; both paths are deterministic.
  if (snapshot.order !== undefined) {
    const idOfHandle = new Map<Entity, number>();
    for (const [id, h] of handleOf) idOfHandle.set(h, id);
    for (const [rName, byParent] of Object.entries(snapshot.order)) {
      const rel = relationByName(rName);
      if (rel === undefined || !rel.ordered) {
        throw new Error(`strata: snapshot order references unknown or unordered relation "${rName}".`);
      }
      for (const [pidStr, childIds] of Object.entries(byParent)) {
        const parent = handleOf.get(Number(pidStr));
        if (parent === undefined) continue;
        const current = store.getReverse(parent, rel);
        if (current.length === 0) continue;
        const isChild = new Set(current);
        const seen = new Set<Entity>();
        const effective: Entity[] = [];
        for (const cid of childIds) {
          const child = handleOf.get(cid);
          if (child === undefined || !isChild.has(child) || seen.has(child)) continue;
          seen.add(child);
          effective.push(child);
        }
        const rest = current.filter((c) => !seen.has(c));
        rest.sort((a, b) => (idOfHandle.get(a) ?? 0) - (idOfHandle.get(b) ?? 0));
        effective.push(...rest);
        store.setOrderedChildren(rel, parent, effective);
      }
    }
  }
}
