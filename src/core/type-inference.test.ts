/**
 * Type-inference conformance (finding R1). These probes pin the schema-literal inference at the
 * TYPE level: a component's field types come from its schema alone, so a value that lies about the
 * schema no longer compiles. The `@ts-expect-error` lines are the real assertions — this file
 * failing to typecheck (an "unused @ts-expect-error", or a probe that stops erroring) is the
 * regression signal. The `it()` blocks add trivial runtime checks so vitest has something to run
 * and so the string-nullability decision is backed by observed behavior, not just the type.
 */
import { describe, expect, it } from "vitest";
import { createWorld, defineComponent, defineQuery, enumOf, field } from "./index";

// Distinct process-global names (the schema registry is not reset in normal runs).
const Position = defineComponent("TI_Position", { x: "f32", y: "f32" });
const Kind = defineComponent("TI_Kind", { shape: enumOf({ rect: 1, ellipse: 2, note: 3 }) });
const Fill = defineComponent("TI_Fill", { r: "u8", g: "u8", b: "u8", a: field("u8", { default: 255 }) });
const Note = defineComponent("TI_Note", { text: "string" });
const posQuery = defineQuery([Position]);
const shapesQuery = defineQuery([Position, Kind, Fill]);

describe("schema-literal type inference (R1)", () => {
  it("read/readField/col are precise with NO type arguments", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 3, y: 4 }], [Kind, { shape: "rect" }]] });

    // read() returns the exact value shape; no `<S>`, no cast.
    const x: number = w.read(e, Position).x;
    expect(x).toBe(3);
    // readField() is keyed by field name and typed from the schema; an enum decodes to its label union.
    const shape: "rect" | "ellipse" | "note" | undefined = w.readField(e, Kind, "shape");
    expect(shape).toBe("rect");

    // col() is field-precise: f32 → Float32Array, u8 → Uint8Array, enum → the unsigned-int union, all cast-free.
    w.query(shapesQuery).each((b) => {
      const px: Float32Array = b.col(Position).x;
      const fr: Uint8Array = b.col(Fill).r;
      const kk: Uint8Array | Uint16Array | Uint32Array = b.col(Kind).shape;
      expect(px[b.rows[0]]).toBe(3);
      expect(fr.length).toBeGreaterThan(0);
      expect(kk[b.rows[0]]).toBe(1); // "rect" → discriminant 1
    });
  });

  it("a `string` field reads `string | null` — an explicit null round-trips", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Note, { text: null }]] });
    const text: string | null | undefined = w.readField(e, Note, "text");
    expect(text).toBeNull(); // decodeField returns the stored null for a present string cell
    expect(w.read(e, Note).text).toBeNull();
  });

  it("rejects lies at compile time", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 0, y: 0 }]] });

    // COMPILE-time probes only: `tsc` checks this closure (the `@ts-expect-error` lines are the
    // assertions), but it is never invoked — several of these calls would throw at runtime by design.
    const _probes = (): void => {
      // An explicit type argument can no longer contradict the schema — the type param IS the schema.
      // @ts-expect-error a value-shaped explicit argument is not a valid schema
      defineComponent<{ x: number }>("TI_Lie", { x: "f32" });

      // @ts-expect-error wrong field-value type in spawn
      w.spawn({ components: [[Position, { x: "no", y: 0 }]] });
      // @ts-expect-error missing required field in spawn
      w.spawn({ components: [[Position, { x: 0 }]] });
      // @ts-expect-error enum label not a variant
      w.spawn({ components: [[Kind, { shape: "hexagon" }]] });

      // @ts-expect-error unknown field name in readField
      w.readField(e, Position, "z");

      // @ts-expect-error field() default checked against the field's value type
      field("f32", { default: "not a number" });

      w.query(posQuery).each((b) => {
        // @ts-expect-error unknown column name
        void b.col(Position).z;
      });
    };
    void _probes;

    expect(w.isAlive(e)).toBe(true);
  });
});
