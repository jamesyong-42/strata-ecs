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
 * A branded string that identifies an entity across stores / persistence (§14.3). A `"key"` field
 * infers `EntityKey | null` as its value type; the Part I runtime stores it as a plain string column
 * and is key-ignorant — the brand is a purely type-level guard so an arbitrary `string` cannot be
 * passed where a key is expected. Brand a plain string for a write with {@link entityKey}.
 */
export type EntityKey = string & { readonly __entityKey: unique symbol };

/** Brand a string as an {@link EntityKey} (§14.3). Identity at runtime — the brand is type-only. */
export function entityKey(s: string): EntityKey {
  return s as EntityKey;
}

/**
 * An enum field type — a closed set of string labels interned to small integer discriminants
 * (§4). The label is the value at the API boundary; the discriminant is what gets stored.
 * `L` is the label union, captured from `enumOf` so a field's value type is its exact labels.
 */
export interface EnumType<L extends string = string> {
  readonly kind: "enum";
  readonly labelToDisc: ReadonlyMap<string, number>;
  readonly discToLabel: ReadonlyMap<number, string>;
  /** Largest discriminant — decides the backing integer width. */
  readonly maxDisc: number;
  /** Phantom marker for the label union `L`; never present at runtime. */
  readonly __label?: L;
}

/** A field's type: a scalar tag or an {@link EnumType}. */
export type FieldType = ScalarType | EnumType;

/**
 * A normalized field descriptor: its type plus an optional declared default (§4). `T` carries the
 * exact field type and `HasDefault` whether a default was declared — the pair lets a schema literal
 * infer both a field's value type and whether it is optional at write time (see {@link WriteOf}).
 */
export interface FieldSpec<T extends FieldType = FieldType, HasDefault extends boolean = boolean> {
  readonly type: T;
  readonly hasDefault: HasDefault;
  readonly default?: unknown;
}

/** What a user may pass for a field in a component schema: a bare type or a {@link FieldSpec}. */
export type FieldInput = FieldType | FieldSpec;

// --- schema-literal type inference (§4, §Part I ref) -------------------------
// A component's field types are recovered from the schema LITERAL, not hand-declared. These mapped
// types turn a `Record<string, FieldInput>` schema into: its read-value shape (ValueOf), its
// write-value shape with defaulted fields optional (WriteOf), and its backing column shape
// (ColumnsOf). Kept in lockstep with encodeField/decodeField (values) and columnKindOf/allocColumn
// (columns) below — the runtime routing they mirror.

/** Value of a scalar field type. `string`/`key` are nullable: a cell reads `null` when unset or
 *  written `null` (encodeField/decodeField round-trip `null`, and fresh string cells are null-filled). */
type ScalarValue<T extends ScalarType> = T extends "bool"
  ? boolean
  : T extends "eid"
    ? Entity
    : T extends "key"
      ? EntityKey | null
      : T extends "string"
        ? string | null
        : number;

/** Value of a concrete field type (scalar or enum). */
type FieldTypeValue<T extends FieldType> = T extends EnumType<infer L>
  ? L
  : T extends ScalarType
    ? ScalarValue<T>
    : never;

/** Value of one schema field input (bare scalar, bare enum, or a `field(...)` spec). */
type FieldValue<F> = F extends string
  ? ScalarValue<F & ScalarType>
  : F extends EnumType<infer L>
    ? L
    : F extends FieldSpec<infer T, boolean>
      ? FieldTypeValue<T>
      : never;

/** The read-value object of a schema: every field present, decoded to its value type. */
export type ValueOf<Sch> = { [K in keyof Sch]: FieldValue<Sch[K]> };

/** Keys whose field declared a default (`field(type, { default })`) — optional at write time. */
type DefaultKeys<Sch> = {
  [K in keyof Sch]: Sch[K] extends FieldSpec<FieldType, true> ? K : never;
}[keyof Sch];

/**
 * The write-value object of a schema (spawn/init): fields WITHOUT a declared default are required;
 * fields WITH one are optional (the runtime fills them, §4). Mirrors {@link encodeComponentValue}.
 */
export type WriteOf<Sch> = { [K in Exclude<keyof Sch, DefaultKeys<Sch>>]: FieldValue<Sch[K]> } & {
  [K in DefaultKeys<Sch>]?: FieldValue<Sch[K]>;
};

/** Backing typed-array for a scalar field type (mirrors columnKindOf → allocColumn). */
type ScalarColumn<T extends ScalarType> = T extends "f64"
  ? Float64Array
  : T extends "f32"
    ? Float32Array
    : T extends "i32"
      ? Int32Array
      : T extends "i16"
        ? Int16Array
        : T extends "i8"
          ? Int8Array
          : T extends "u32" | "eid"
            ? Uint32Array
            : T extends "u16"
              ? Uint16Array
              : T extends "u8" | "bool"
                ? Uint8Array
                : T extends "string" | "key"
                  ? (string | null)[]
                  : never;

/** Backing column for a concrete field type. An enum's integer width is a runtime property of its
 *  largest discriminant (columnKindOf), unknowable to the type system — hence the unsigned union. */
type FieldTypeColumn<T extends FieldType> = T extends EnumType
  ? Uint8Array | Uint16Array | Uint32Array
  : T extends ScalarType
    ? ScalarColumn<T>
    : never;

/** Backing column for one schema field input. */
type FieldColumn<F> = F extends string
  ? ScalarColumn<F & ScalarType>
  : F extends EnumType
    ? Uint8Array | Uint16Array | Uint32Array
    : F extends FieldSpec<infer T, boolean>
      ? FieldTypeColumn<T>
      : never;

/**
 * The backing columns of a schema, keyed by field name — what {@link Component}'s `col()` returns
 * with zero casts. A bare {@link Component} (schema `Record<string, FieldInput>`) degrades to the
 * loose `{ [name: string]: Column }`, exactly the pre-inference shape.
 */
export type ColumnsOf<Sch> = { [K in keyof Sch]: FieldColumn<Sch[K]> };

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
export function enumOf<const L extends string>(variants: readonly L[]): EnumType<L>;
export function enumOf<const L extends string>(variants: Record<L, number>): EnumType<L>;
export function enumOf(variants: readonly string[] | Record<string, number>): EnumType {
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
 * for `field(type)` — a required field with no default. The `default` is checked against the
 * field's value type, and the returned {@link FieldSpec} carries whether a default was declared so
 * the schema literal can make the field optional at write time ({@link WriteOf}).
 */
export function field<const T extends FieldType>(type: T): FieldSpec<T, false>;
export function field<const T extends FieldType>(
  type: T,
  opts: { default: FieldTypeValue<T> },
): FieldSpec<T, true>;
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
