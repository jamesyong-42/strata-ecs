/**
 * The entity handle — a packed `u32` (design §2).
 *
 * Bit layout (the editor default, 20/12 split):
 *
 * ```
 *  31            20 19             0
 * ┌────────────────┬────────────────┐
 * │ generation(12) │   index(20)    │
 * └────────────────┴────────────────┘
 * ```
 *
 * - **index** (low 20 bits) — a direct row into the entity-table arrays → O(1) access.
 *   ~1,048,576 concurrent slots.
 * - **generation** (high 12 bits) — bumped when a slot is recycled, so a stale handle
 *   (pointing at a freed-then-reused slot) is caught by a generation mismatch. 4,096
 *   generations per slot; `generation 0` is reserved as "never issued".
 *
 * A handle is a **name, not a pointer**: it carries a slot, and the slot resolves through
 * the entity table (`archetypeId[slot]`, `rowInArch[slot]`) to wherever the data currently
 * lives — so the handle stays constant as the entity migrates between archetypes/rows.
 *
 * The value is kept as an unsigned 32-bit number (0 … 2³²−1). All packing/extraction goes
 * through the helpers here so the unsigned discipline is enforced in exactly one place.
 */

import { DEV } from "./dev";

/** An opaque entity handle. Runtime-local and disposable (§2). */
export type Entity = number & { readonly __brand: "Entity" };

/** Width of the slot-index field, in bits. */
export const INDEX_BITS = 20;
/** Width of the generation field, in bits. */
export const GEN_BITS = 12;

/** Mask selecting the index field (low `INDEX_BITS` bits). */
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0x000FFFFF
/** Mask selecting the generation field once shifted down (`GEN_BITS` bits). */
export const GEN_MASK = (1 << GEN_BITS) - 1; // 0x00000FFF

/** Maximum addressable slots (2^INDEX_BITS). Live-entity capacity is bounded by this. */
export const MAX_SLOTS = 1 << INDEX_BITS; // 1,048,576
/** Highest generation value that fits the field. Generation wraps back to 1 past this. */
export const MAX_GENERATION = GEN_MASK; // 4,095

/**
 * The "never issued" handle: slot 0, generation 0. Generation 0 is reserved, so this value
 * is never a live entity — it reads as not-alive against any table and is a safe default for
 * an unset `eid` column cell (which validate-on-read then reports as dangling).
 */
export const NULL_ENTITY = 0 as Entity;

/** Pack a slot index and generation into a handle. Result is always unsigned (0 … 2³²−1). */
export function pack(index: number, generation: number): Entity {
  // DEV guard (§2): pack() masks both fields, so an out-of-range slot/generation would silently
  // ALIAS a different handle rather than fail. Correctness depends on upstream clamping; assert it
  // here in dev so any future path that overflows the 20/12 split throws instead of corrupting.
  if (DEV && (index < 0 || index >= MAX_SLOTS || generation < 0 || generation > MAX_GENERATION)) {
    throw new Error(
      `strata: pack() out of range — index ${index} must be in [0, ${MAX_SLOTS}) and generation ${generation} in [0, ${MAX_GENERATION}] for the 20/12 handle split (§2). An upstream slot/generation overflow would otherwise alias silently.`,
    );
  }
  return ((((generation & GEN_MASK) << INDEX_BITS) | (index & INDEX_MASK)) >>> 0) as Entity;
}

/** Extract the slot index (low 20 bits) from a handle. */
export function slotOf(e: Entity): number {
  return e & INDEX_MASK;
}

/** Extract the generation (high 12 bits) from a handle. */
export function genOf(e: Entity): number {
  // `>>>` first coerces to uint32, so high-bit generations extract correctly.
  return (e >>> INDEX_BITS) & GEN_MASK;
}
