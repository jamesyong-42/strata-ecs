/**
 * Field types and their storage routing (design §3.4, §4).
 *
 * Every component field is a number, an enum, an entity reference, or freeform text. Each
 * field type routes deterministically to a backing column: a typed array for everything
 * except `string`/`key`, which are backed by a `(string | null)[]` that owns text per-cell.
 */

import type { Entity } from "./entity";

/** Scalar (non-enum) field types. */
export type ScalarType =
  | "f32"
  | "f64"
  | "i8"
  | "i16"
  | "i32"
  | "u8"
  | "u16"
  | "u32"
  | "bool"
  | "eid"
  | "string"
  | "key";

/**
 * A branded string that identifies an entity across stores / persistence (§14.3). A `key` field
 * reads and writes `EntityKey | null`; the Part I runtime stores it as a plain string column and
 * is key-ignorant — the brand is a purely type-level guard so an arbitrary `string` cannot be
 * passed where a key is expected. Annotate the field's value type with it, e.g.
 * `defineComponent<{ ref: EntityKey | null }>("Ref", { ref: "key" })`.
 */
export type EntityKey = string & { readonly __entityKey: unique symbol };

/** Brand a string as an {@link EntityKey} (§14.3). Identity at runtime — the brand is type-only. */
export function entityKey(s: string): EntityKey {
  return s as EntityKey;
}

/**
 * An enum field type — a closed set of string labels interned to small integer discriminants
 * (§4). The label is the value at the API boundary; the discriminant is what gets stored.
 */
export interface EnumType {
  readonly kind: "enum";
  readonly labelToDisc: ReadonlyMap<string, number>;
  readonly discToLabel: ReadonlyMap<number, string>;
  /** Largest discriminant — decides the backing integer width. */
  readonly maxDisc: number;
}

/** A field's type: a scalar tag or an {@link EnumType}. */
export type FieldType = ScalarType | EnumType;

/** A normalized field descriptor: its type plus an optional declared default (§4). */
export interface FieldSpec {
  readonly type: FieldType;
  readonly hasDefault: boolean;
  readonly default?: unknown;
}

/** What a user may pass for a field in a component schema: a bare type or a {@link FieldSpec}. */
export type FieldInput = FieldType | FieldSpec;

/** A backing-column element kind. `string` covers both `string` and `key` fields. */
export type ColumnKind = "f64" | "f32" | "i32" | "i16" | "i8" | "u32" | "u16" | "u8" | "string";

/** A stored column: a typed array, or a per-cell-owned string array (§3.4). */
export type Column =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | (string | null)[];

export function isEnumType(x: unknown): x is EnumType {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "enum";
}

function isFieldSpec(x: unknown): x is FieldSpec {
  return (
    typeof x === "object" &&
    x !== null &&
    "type" in x &&
    "hasDefault" in x &&
    !isEnumType(x)
  );
}

/**
 * Declare an enum field.
 * - Array form → **positional** discriminants (`0..n-1`); local-only, reorder-hostile (§4).
 * - Object form → **explicit stable** discriminants; safe to persist/sync.
 */
export function enumOf(variants: string[]): EnumType;
export function enumOf(variants: Record<string, number>): EnumType;
export function enumOf(variants: string[] | Record<string, number>): EnumType {
  const labelToDisc = new Map<string, number>();
  const discToLabel = new Map<number, string>();
  let maxDisc = 0;

  const add = (label: string, disc: number): void => {
    if (!Number.isInteger(disc) || disc < 0 || disc > 0xffffffff) {
      throw new Error(
        `strata: enum discriminant for "${label}" must be an integer in [0, 2^32) (got ${disc}); the backing column is at most a Uint32Array.`,
      );
    }
    if (labelToDisc.has(label)) {
      throw new Error(`strata: duplicate enum label "${label}".`);
    }
    if (discToLabel.has(disc)) {
      throw new Error(`strata: duplicate enum discriminant ${disc} (labels "${discToLabel.get(disc)}" and "${label}").`);
    }
    labelToDisc.set(label, disc);
    discToLabel.set(disc, label);
    if (disc > maxDisc) maxDisc = disc;
  };

  if (Array.isArray(variants)) {
    if (variants.length === 0) throw new Error("strata: enumOf requires at least one variant.");
    variants.forEach((label, i) => add(label, i));
  } else {
    const entries = Object.entries(variants);
    if (entries.length === 0) throw new Error("strata: enumOf requires at least one variant.");
    for (const [label, disc] of entries) add(label, disc);
  }

  return { kind: "enum", labelToDisc, discToLabel, maxDisc };
}

/**
 * Wrap a field type with options (currently a per-field default, §4). A bare type is shorthand
 * for `field(type)` — a required field with no default.
 */
export function field(type: FieldType, opts?: { default?: unknown }): FieldSpec {
  if (opts && "default" in opts) {
    return { type, hasDefault: true, default: opts.default };
  }
  return { type, hasDefault: false };
}

/** Normalize a schema field input (bare type or spec) into a {@link FieldSpec}. */
export function normalizeField(input: FieldInput): FieldSpec {
  if (typeof input === "string") return { type: input, hasDefault: false };
  if (isEnumType(input)) return { type: input, hasDefault: false };
  if (isFieldSpec(input)) return input;
  throw new Error("strata: invalid field descriptor.");
}

/** The backing-column kind a field type routes to (§4). */
export function columnKindOf(type: FieldType): ColumnKind {
  if (isEnumType(type)) {
    // Smallest unsigned integer that fits the largest discriminant.
    return type.maxDisc < 256 ? "u8" : type.maxDisc < 65536 ? "u16" : "u32";
  }
  switch (type) {
    case "f64":
      return "f64";
    case "f32":
      return "f32";
    case "i32":
      return "i32";
    case "i16":
      return "i16";
    case "i8":
      return "i8";
    case "u32":
    case "eid": // entity reference — a packed u32 handle (validate-on-read is separate)
      return "u32";
    case "u16":
      return "u16";
    case "u8":
    case "bool": // 0 / 1
      return "u8";
    case "string":
    case "key": // storage-identical to string; the brand lives only at the type surface (§14.3)
      return "string";
  }
}

export function isStringKind(kind: ColumnKind): boolean {
  return kind === "string";
}

/** Allocate a fresh column of `kind` sized to `capacity`. String columns are null-filled (§3.4). */
export function allocColumn(kind: ColumnKind, capacity: number): Column {
  switch (kind) {
    case "f64":
      return new Float64Array(capacity);
    case "f32":
      return new Float32Array(capacity);
    case "i32":
      return new Int32Array(capacity);
    case "i16":
      return new Int16Array(capacity);
    case "i8":
      return new Int8Array(capacity);
    case "u32":
      return new Uint32Array(capacity);
    case "u16":
      return new Uint16Array(capacity);
    case "u8":
      return new Uint8Array(capacity);
    case "string": {
      // Capacity invariant (§3.4): every string cell is `null`, never `undefined`.
      const a = new Array<string | null>(capacity);
      a.fill(null);
      return a;
    }
  }
}

/**
 * Grow a column to `newCapacity` (> current length), preserving existing cells. Typed arrays
 * are reallocated + copied; string columns are extended with `null` (never `undefined`, §3.4).
 * Returns the (possibly new) column.
 */
export function growColumn(column: Column, kind: ColumnKind, newCapacity: number): Column {
  if (kind === "string") {
    const a = column as (string | null)[];
    for (let i = a.length; i < newCapacity; i++) a[i] = null;
    return a;
  }
  const typed = column as Exclude<Column, (string | null)[]>;
  const next = allocColumn(kind, newCapacity) as Exclude<Column, (string | null)[]>;
  next.set(typed);
  return next;
}

/**
 * Encode a user-facing field value into its stored form (a number for typed columns, a
 * `string | null` for string columns). Throws on an unknown enum label.
 */
export function encodeField(type: FieldType, value: unknown): number | string | null {
  if (isEnumType(type)) {
    const disc = type.labelToDisc.get(value as string);
    if (disc === undefined) {
      throw new Error(
        `strata: "${String(value)}" is not a variant of this enum (expected one of ${[...type.labelToDisc.keys()].map((l) => `"${l}"`).join(", ")}).`,
      );
    }
    return disc;
  }
  switch (type) {
    case "bool":
      return value ? 1 : 0;
    case "string":
    case "key":
      return value == null ? null : (value as string);
    case "eid":
      return (value as number) >>> 0; // packed handle, kept unsigned
    default:
      return value as number;
  }
}

/** Write a stored value into a column cell (typed-array store or string assignment). */
export function writeCell(
  column: Column,
  kind: ColumnKind,
  row: number,
  stored: number | string | null,
): void {
  if (kind === "string") {
    (column as (string | null)[])[row] = stored as string | null;
  } else {
    (column as Exclude<Column, (string | null)[]>)[row] = stored as number;
  }
}

/** Read a stored value from a column cell. */
export function readCell(column: Column, kind: ColumnKind, row: number): number | string | null {
  if (kind === "string") {
    return (column as (string | null)[])[row];
  }
  return (column as Exclude<Column, (string | null)[]>)[row];
}

/**
 * Copy cell `from → to` within a column. For string columns the source is nulled afterward,
 * upholding the "no live reference above `count`" invariant on swap-and-pop (§3.4, §5.5).
 */
export function moveCell(column: Column, kind: ColumnKind, from: number, to: number): void {
  if (kind === "string") {
    const a = column as (string | null)[];
    a[to] = a[from];
    a[from] = null;
  } else {
    const a = column as Exclude<Column, (string | null)[]>;
    a[to] = a[from];
  }
}

/** Null a string cell (no-op for typed columns, where a stale number is harmless, §3.4/§5.5). */
export function clearCell(column: Column, kind: ColumnKind, row: number): void {
  if (kind === "string") {
    (column as (string | null)[])[row] = null;
  }
}

/** Decode a stored field value back into its user-facing form. */
export function decodeField(type: FieldType, stored: number | string | null): unknown {
  if (isEnumType(type)) {
    return type.discToLabel.get(stored as number);
  }
  switch (type) {
    case "bool":
      return stored === 1;
    case "string":
    case "key":
      return stored as string | null;
    case "eid":
      return (stored as number) as Entity;
    default:
      return stored as number;
  }
}
