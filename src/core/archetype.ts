/**
 * An archetype — the set of entities sharing the exact same set of *component types* (tags do
 * not participate, §3.1). Stores one column per field (SoA), a row→entity back-pointer, and a
 * live-row count. The empty archetype (no components) is valid and holds componentless/tag-only
 * entities so they stay queryable (§3.1, §5.2).
 */

import { type Column, allocColumn, growColumn } from "./field";
import type { ComponentId, FieldId, FieldMeta } from "./schema";

const INITIAL_ROW_CAPACITY = 8;

export class Archetype {
  /** Runtime-local archetype id. */
  readonly id: number;
  /** Canonical signature key: sorted component ids joined — archetype identity for dedup. */
  readonly key: string;
  /** The component ids present, sorted ascending. */
  readonly componentIds: readonly ComponentId[];
  /** The component ids present, as a set — O(1) membership for `has` (§3.1). */
  readonly componentSet: ReadonlySet<ComponentId>;
  /** Every field across the present components (the columns this archetype owns). */
  readonly fields: readonly FieldMeta[];
  /** One column per field, keyed by global FieldId. */
  readonly columns: Map<FieldId, Column>;
  /** Row → packed entity handle (the back-pointer swap-and-pop relies on, §5.5). */
  entities: Uint32Array;
  /** Number of live rows. */
  count = 0;

  private capacity: number;

  constructor(id: number, key: string, componentIds: readonly ComponentId[], fields: readonly FieldMeta[]) {
    this.id = id;
    this.key = key;
    this.componentIds = componentIds;
    this.componentSet = new Set(componentIds);
    this.fields = fields;
    this.capacity = INITIAL_ROW_CAPACITY;
    this.entities = new Uint32Array(this.capacity);
    this.columns = new Map();
    for (const f of fields) {
      this.columns.set(f.fieldId, allocColumn(f.kind, this.capacity));
    }
  }

  /** Whether this archetype stores the given field (i.e. its component is present). */
  hasField(fieldId: FieldId): boolean {
    return this.columns.has(fieldId);
  }

  /** Whether the given component is present in this archetype. */
  hasComponent(componentId: ComponentId): boolean {
    return this.componentSet.has(componentId);
  }

  /** Grow the columns + back-pointer array to hold at least `rows` (geometric doubling). */
  ensureCapacity(rows: number): void {
    if (rows <= this.capacity) return;
    let cap = this.capacity;
    while (cap < rows) cap *= 2;

    const entities = new Uint32Array(cap);
    entities.set(this.entities);
    this.entities = entities;

    for (const f of this.fields) {
      const grown = growColumn(this.columns.get(f.fieldId) as Column, f.kind, cap);
      this.columns.set(f.fieldId, grown);
    }
    this.capacity = cap;
  }
}
