/**
 * Canonical values and cell equality (Patch Note 005 §2) — the ship-blocking baseline-compare rule.
 *
 * Reconcile's entire conflict model rests on comparing `runtime(cell)` against `baseline(cell)`
 * (Part III §13.3). The two sides must store values IDENTICALLY or a cell diverges with no edit in
 * flight and every later remote value to it is dropped forever (§2.1). So EVERY value entering the
 * document or the baseline is canonical, and cell equality is field-wise equality of canonical
 * values (§2.2).
 *
 * CRITICAL SUBTLETY (§2.4): `canon(C, v)` must equal what `RuntimeStore.read` returns AFTER writing
 * `v` — i.e. the value after TYPED-ARRAY COERCION. `encodeField` alone (field.ts:347) does NOT
 * reproduce integer modular wrap (300 into u8 = 44) or `Math.fround`, because that coercion happens
 * when the encoded number is stored INTO the column (`writeCell`, field.ts:371), not inside
 * `encodeField`. So `canon` inserts the column coercion between encode and decode by pushing the
 * encoded value through a one-element typed array of the field's routed kind — the SAME operation
 * the runtime column performs, hence provably identical (proven in canon.test.ts against a real
 * `RuntimeStore`). Wrap, never clamp (§2.4): `300 & 0xFF = 44`, not `255`.
 */

import type { Component, FieldMeta, Resource } from "../core/schema";
import { encodeComponentValue } from "../core/schema";
import { type ColumnKind, decodeField, isEnumType } from "../core/field";
import type { ComponentValue } from "./types";

// One scratch cell per numeric column kind. Storing into it applies EXACTLY the ECMAScript typed-array
// coercion the runtime column applies on write (§2.4): `Math.fround` for f32; ToUint8/ToInt8/… modular
// wrap for the integer kinds; NaN/±Inf → 0 for integers; f32/f64 keep NaN/±Inf. Reused, never grown.
const NUMERIC_SCRATCH = {
  f64: new Float64Array(1),
  f32: new Float32Array(1),
  i32: new Int32Array(1),
  i16: new Int16Array(1),
  i8: new Int8Array(1),
  u32: new Uint32Array(1),
  u16: new Uint16Array(1),
  u8: new Uint8Array(1),
} as const;

/** Push an encoded stored value through the field's column so it reads back as the runtime stores it. */
function coerceStored(kind: ColumnKind, stored: number | string | null): number | string | null {
  if (kind === "string") return stored; // string/key columns assign the reference as-is (field.ts:377)
  const scratch = NUMERIC_SCRATCH[kind];
  scratch[0] = stored as number; // the typed-array store IS the coercion (fround / modular wrap, §2.4)
  return scratch[0];
}

/**
 * `canon(C, v) = decode ∘ coerce ∘ encode` — the value as it reads back through `C`'s columns (§2.2).
 * Reuses the shipped encoder (`encodeComponentValue`, schema.ts:270) for default-fill + validation,
 * then coerces each encoded value through its column and decodes — so the result field-wise-equals
 * `RuntimeStore.read(e, C)` after `projectComponent(e, C, v)`.
 *
 * TOTAL over WELL-FORMED values; THROWS on malformation (missing no-default field → schema.ts:282,
 * unknown enum label → field.ts:351), exactly as a local write would. Reconcile MUST NOT feed it an
 * unvalidated inbound value — that path is {@link tryCanon}, which never throws (§2.3).
 */
export function canon(C: Component, v: ComponentValue): ComponentValue {
  const encoded = encodeComponentValue(C, v as Record<string, unknown>);
  const out: ComponentValue = {};
  for (const f of C.fields) {
    out[f.name] = decodeField(f.spec.type, coerceStored(f.kind, encoded.get(f.fieldId) as number | string | null));
  }
  return out;
}

/**
 * The canonical form of a RESOURCE value (§2, §7). A resource is OBJECT-backed, not column-backed:
 * `RuntimeStore.setResource` stores the raw value object wholesale (runtime-store.ts:998) and
 * `getResource` returns it unchanged — it never round-trips a typed array. So "the value as it reads
 * back" (§2.2) is the raw value with declared defaults filled, with NO typed-array coercion —
 * applying f32 fround here would strand every float resource cell against the raw runtime value, the
 * exact §2.1 bug inverted. Mirrors `setResource`'s object construction so `baseline.getResource`
 * field-wise-equals `oracle.getResource` (property P1). Throws on a missing no-default field, as the
 * runtime does.
 */
export function canonResource(res: Resource, v: ComponentValue): ComponentValue {
  const out: ComponentValue = {};
  const value = v as Record<string, unknown>;
  for (const f of res.fields) {
    if (value !== undefined && Object.prototype.hasOwnProperty.call(value, f.name)) {
      out[f.name] = value[f.name];
    } else if (f.spec.hasDefault) {
      out[f.name] = f.spec.default;
    } else {
      throw new Error(`strata: resource "${res.name}" is missing required field "${f.name}".`);
    }
  }
  return out;
}

/**
 * Scalar equality with the two float subtleties reconcile needs (§2.2): `NaN === NaN` (a value that
 * survives an f32 round-trip must compare equal to itself, or the cell strands forever — the
 * `x !== x && y !== y` clause), and `+0 === −0` (round-tripping collapses signed zero, so a cell that
 * reconverged to `+0` must not strand against a baseline holding `−0` — plain `===` gives this, where
 * `Object.is` would not). `scalarEquals` is the unique predicate that unifies NaN AND collapses ±0.
 */
export function scalarEquals(x: unknown, y: unknown): boolean {
  return x === y || (x !== x && y !== y);
}

/**
 * Cell equality — field-wise {@link scalarEquals} over two canonical values (§2.2). Both-undefined is
 * equal; one-undefined is not. Callers pass two `canon(C, ·)` outputs for the SAME component, so the
 * key sets match; the length + own-key guard makes a mismatched shape unequal rather than throwing.
 */
export function cellEquals(a: ComponentValue | undefined, b: ComponentValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b; // both-undefined equal; one-undefined not
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!scalarEquals(a[k], b[k])) return false;
  }
  return true;
}

/** A per-cell reject — quarantines exactly one malformed inbound fact, naming the offending field (§2.3). */
export type TryCanonResult =
  | { ok: true; value: ComponentValue }
  | { ok: false; field: string; reason: string };

/**
 * Inbound-safe canonicalization (§2.3) — the reconcile gate. NEVER throws: a buggy or malicious peer
 * may malform a value, and a throw mid-drain is unacceptable. Per field:
 * - a DECLARED-DEFAULT field that is missing is DEFAULT-FILLED (identical to a local write, §2.3);
 * - any other malformation — wrong JS type, non-finite where finite is required (an integer/eid
 *   column), a missing no-default field, an unknown enum label — REJECTS the single fact (§2.3).
 *
 * A range-but-representable value (300 into u8) is NOT malformed — it wraps identically to a local
 * write (§2.4). Rejecting writes NEITHER the runtime NOR the baseline, so it provably cannot strand
 * the cell (§2.3): whatever relation held before still holds.
 */
export function tryCanon(C: Component, v: ComponentValue): TryCanonResult {
  const value = v as Record<string, unknown>;
  const out: ComponentValue = {};
  for (const f of C.fields) {
    let raw: unknown;
    if (value !== undefined && Object.prototype.hasOwnProperty.call(value, f.name)) {
      raw = value[f.name];
    } else if (f.spec.hasDefault) {
      raw = f.spec.default; // default-fill — identical to encodeComponentValue's local-write behavior (§2.3)
    } else {
      return { ok: false, field: f.name, reason: "missing required field with no declared default" };
    }
    const field = tryCanonField(f, raw);
    if (!field.ok) return { ok: false, field: f.name, reason: field.reason };
    out[f.name] = field.value;
  }
  return { ok: true, value: out };
}

/** Validate one inbound field value by its type, then coerce+decode it as {@link canon} would. */
function tryCanonField(f: FieldMeta, raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const type = f.spec.type;
  if (isEnumType(type)) {
    if (typeof raw !== "string") return { ok: false, reason: "expected an enum label string" };
    const disc = type.labelToDisc.get(raw);
    if (disc === undefined) return { ok: false, reason: `unknown enum label "${raw}"` };
    return { ok: true, value: decodeField(type, coerceStored(f.kind, disc)) };
  }
  switch (type) {
    case "bool":
      if (typeof raw !== "boolean") return { ok: false, reason: "expected a boolean" };
      return { ok: true, value: decodeField(type, coerceStored(f.kind, raw ? 1 : 0)) };
    case "string":
    case "key":
      if (raw !== null && typeof raw !== "string") return { ok: false, reason: "expected a string or null" };
      return { ok: true, value: raw === null ? null : (raw as string) };
    case "eid":
      // §7: a replicated component MUST NOT carry `eid`; this branch exists only so canon is defined
      // over the whole field taxonomy. Finite required — a non-finite eid is malformed.
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, reason: "expected a finite number" };
      return { ok: true, value: decodeField(type, coerceStored(f.kind, raw >>> 0)) };
    case "f32":
    case "f64":
      // Float columns keep NaN/±Inf (they survive the round-trip, §2.4) — only a non-number rejects.
      if (typeof raw !== "number") return { ok: false, reason: "expected a number" };
      return { ok: true, value: decodeField(type, coerceStored(f.kind, raw)) };
    default:
      // Integer columns (i8/i16/i32/u8/u16/u32): finite required (NaN/±Inf into an int silently becomes
      // 0 — a lossy surprise §2.3 quarantines); an in-range-or-not value otherwise WRAPS (§2.4).
      if (typeof raw !== "number") return { ok: false, reason: "expected a number" };
      if (!Number.isFinite(raw)) return { ok: false, reason: "expected a finite number (non-finite into an integer column)" };
      return { ok: true, value: decodeField(type, coerceStored(f.kind, raw)) };
  }
}
