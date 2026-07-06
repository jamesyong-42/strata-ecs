/**
 * THE schema module — every `define*` call in the example lives here, and only here.
 *
 * strata's schema registry is process-global (each name is defined once per process), so a
 * Vite HMR re-execution of this module would throw `"Position" is already defined`. Two
 * guards make dev painless:
 *
 *   1. the HMR hook at the bottom — editing this file always escalates to a full page
 *      reload, never a hot re-run (autosave will make the reload invisible once E3 lands).
 *   2. a define-once cache on `globalThis` — absorbs the one re-execution HMR performs
 *      before the reload lands, and any other re-execution path.
 *
 * This is the reference pattern for any strata + Vite app.
 *
 * The schema is split DOCUMENT CONTENT vs INTERACTION STATE on purpose. Document content is
 * what Part III (`@vibecook/strata-ecs/durable`) will make collaborative later; interaction state stays
 * runtime-only forever. Durability is a creation path, not a flag (design.md §11.1) — this
 * file draws that line on day one so collaboration attaches without a rewrite.
 */

import { defineComponent, defineRelation, defineResource, defineTag, enumOf, field } from "@vibecook/strata-ecs";

function defineSchema() {
  return {
    // ── document content (future-durable) ─────────────────────────────────────────────
    // Split at conflict granularity (design.md §4/§13.4): Position / Size / Fill are
    // separate components, not a fat Transform — the component is the future conflict unit.

    /** World-space center of a shape. */
    Position: defineComponent("Position", { x: "f32", y: "f32" }),
    /** Width/height in world units. */
    Size: defineComponent("Size", { w: "f32", h: "f32" }),
    /** RGBA fill, 0–255 per channel. */
    Fill: defineComponent("Fill", {
      r: "u8",
      g: "u8",
      b: "u8",
      a: field("u8", { default: 255 }),
    }),
    /** Explicit z-order — row order is unstable in an archetype ECS (swap-and-pop), so
     *  stacking is app data, never iteration order. */
    ZIndex: defineComponent("ZIndex", { z: "i32" }),
    /** What to draw. Explicit discriminants: this enum outlives the process via snapshots
     *  (design.md §8.1) — positional enums are for local-only state (see Gesture below). */
    Kind: defineComponent("Kind", {
      shape: enumOf({ rect: 1, ellipse: 2, note: 3 }),
    }),
    /** Sticky-note text. */
    Label: defineComponent("Label", { text: "string" }),
    /**
     * Velocity lives on EVERY shape from birth (defaults 0) so simulate mode is a `runIf`
     * phase gate costing zero archetype migrations — bulk add/remove churn is strata's
     * measured weak path, dense iteration over two extra columns is its measured strength.
     */
    Velocity: defineComponent("Velocity", {
      vx: field("f32", { default: 0 }),
      vy: field("f32", { default: 0 }),
    }),
    /** Connector edges between shapes. Deleting either endpoint cascade-cleans the edge —
     *  the seeded arrows vanish with zero app cleanup code. */
    ConnectedTo: defineRelation("ConnectedTo", { arity: "many" }),

    // ── interaction state (runtime-only forever) ──────────────────────────────────────

    /** Selection. Committed in bulk at gesture end — never toggled per frame. */
    Selected: defineTag("Selected"),
    /** The active pointer gesture, written by the input layer between frames. Positional
     *  enum on purpose: local-only state, deliberately contrasted with Kind's explicit
     *  discriminants. */
    Gesture: defineResource(
      "Gesture",
      { mode: enumOf(["idle", "drag", "marquee", "draw"]), dx: "f32", dy: "f32" },
    ),
    /** The viewport: world coords of the view center, zoom (px per world unit), and the
     *  canvas size in CSS px — everything CullSystem needs to build the view rect. */
    Camera: defineResource("Camera", {
      x: "f32",
      y: "f32",
      zoom: "f32",
      w: "f32",
      h: "f32",
    }),
    /** Gates the simulate phase; `bound` is the half-extent of the bounce box (set from the
     *  seeded board's spread). The whole phase costs zero ticks while `on` is false. */
    SimMode: defineResource("SimMode", {
      on: "bool",
      bound: field("f32", { default: 4000 }),
    }),

    // ── collab presence (ephemeral — Part IV, `?collab` mode only) ─────────────────────
    // These live on EPHEMERAL entities (strata-ecs/ephemeral), never on the durable document:
    // one per peer, self-expiring on TTL, projected in as `Not(Local)` for everyone else. They
    // are deliberately NOT drawable columns (the `renderable` query never names them), so a
    // moving remote cursor repaints the every-frame OVERLAY only and never wakes a content
    // repaint (design §15.6). Unused in local-only mode — the store simply never spawns them.

    /** A peer's live pointer, in WORLD coordinates (so it lands on the same shape at any zoom). */
    CursorPos: defineComponent("CursorPos", { x: "f32", y: "f32" }),
    /** A peer's display identity — a deterministic handle + a hashed color, derived from its
     *  session peerId (never the key prefix, 006 B5). What the cursor label + selection tint use. */
    PresenceInfo: defineComponent("PresenceInfo", { name: "string", color: "string" }),
    /** Membership-as-signal (design §15.6): PRESENT while the peer has a primary selection,
     *  ABSENT otherwise. `targetKey` is the durable `doc.keyOf` of the selected shape — a `key`
     *  field (a cross-store reference, resolved with `doc.resolve` on the receiver, §14.3). */
    SelectionRef: defineComponent("SelectionRef", { targetKey: "key" }),
  };
}

type Schema = ReturnType<typeof defineSchema>;
const CACHE_KEY = "__strata_canvas_editor_schema__";
const cache = globalThis as typeof globalThis & { [CACHE_KEY]?: Schema };
const schema: Schema = (cache[CACHE_KEY] ??= defineSchema());

export const {
  Position,
  Size,
  Fill,
  ZIndex,
  Kind,
  Label,
  Velocity,
  ConnectedTo,
  Selected,
  Gesture,
  Camera,
  SimMode,
  CursorPos,
  PresenceInfo,
  SelectionRef,
} = schema;

// Editing the schema = full page reload, never a hot re-run (the registry is process-global).
// The globalThis cache above absorbs the one re-execution HMR does before invalidate() lands,
// then the reload gives the edited schema a clean process to define itself in.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
