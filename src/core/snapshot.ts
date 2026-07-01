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
  relationByName,
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
  relations: Record<string, number[]>;
}

interface Snapshot {
  meta: { name: string; formatVersion: number };
  resources: Record<string, unknown>;
  entities: EntityRecord[];
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

    const relations: Record<string, number[]> = {};
    for (const { relation, targets } of store.relationsOf(e)) {
      const ids: number[] = [];
      for (const t of targets) {
        const id = idOf.get(t);
        if (id !== undefined) ids.push(id);
      }
      if (ids.length > 0) relations[relation.name] = ids;
    }

    records.push({ id: i, components, tags, relations });
  }

  const snapshot: Snapshot = {
    meta: { name, formatVersion: FORMAT_VERSION },
    resources,
    entities: records,
  };
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

/** Rebuild the store's state from bytes into an EMPTY store (§8.2). Throws on unknown schema names. */
export function importSnapshot(store: RuntimeStore, bytes: Uint8Array): void {
  if (store.liveCount() > 0) {
    throw new Error("strata: import() requires an empty world — create a fresh world to load a snapshot.");
  }
  const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Snapshot;
  if (snapshot.meta?.formatVersion !== FORMAT_VERSION) {
    throw new Error(`strata: unsupported snapshot format version ${snapshot.meta?.formatVersion}.`);
  }

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
    for (const [rName, targetIds] of Object.entries(record.relations)) {
      const rel = relationByName(rName);
      if (rel === undefined) throw new Error(`strata: snapshot references unknown relation "${rName}".`);
      for (const tid of targetIds) {
        const target = handleOf.get(tid);
        if (target === undefined) continue;
        if (rel.arity === "one") store.setRelation(handle, rel, target);
        else store.addRelation(handle, rel, target);
      }
    }
  }
}
