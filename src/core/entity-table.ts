/**
 * The entity table — the SoA store of entity identity and placement (design §2, §5.2).
 *
 * Four parallel arrays keyed by slot index:
 * - `generations` — current generation per slot (0 = never issued).
 * - `archetypeId` — which archetype a live entity is in, or `NO_ARCHETYPE` if identity-only.
 * - `rowInArch`   — its row within that archetype's columns, or `NO_ROW` if identity-only.
 * - `freeList`    — recycled slot indices (LIFO).
 *
 * Identity (slot + generation) is allocated eagerly and is always safe to touch — it reorders
 * no columns (§5.2). Placement (`archetypeId`/`rowInArch`) is written by the archetype store
 * when it places/migrates a row; this table only owns the storage and the sentinels.
 */

import {
  type Entity,
  MAX_GENERATION,
  MAX_SLOTS,
  genOf,
  pack,
  slotOf,
} from "./entity";
import { devWarn } from "./dev";

/**
 * Sentinel for "this slot has identity but no placement". A `Uint32Array` cannot hold
 * `undefined`, so "none" needs an explicit reserved value. `archetypeId` and `rowInArch`
 * are independent sentinels that happen to share this value; both are checked (§2).
 */
export const NO_ARCHETYPE = 0xffffffff;
/** Sentinel for "this slot has no row" (see {@link NO_ARCHETYPE}). */
export const NO_ROW = 0xffffffff;

const DEFAULT_INITIAL_CAPACITY = 1024;

export class EntityTable {
  private generations: Uint32Array;
  private archetypeIds: Uint32Array;
  private rows: Uint32Array;
  private readonly freeList: number[] = [];

  /** High-water mark: slots `[0, slotCount)` have been allocated at least once. */
  private slotCount = 0;
  private capacity: number;

  constructor(initialCapacity: number = DEFAULT_INITIAL_CAPACITY) {
    // Enforce the MAX_SLOTS bound on every array-sizing path, not just grow(): a capacity
    // above the 20-bit addressable range would let allocate() hand out a slot index that
    // pack() silently masks/aliases (§2), so reject it up front.
    if (initialCapacity > MAX_SLOTS) {
      throw new Error(
        `strata: initial entity capacity ${initialCapacity} exceeds the maximum of ${MAX_SLOTS} live entities for the 20/12 handle split (§2).`,
      );
    }
    this.capacity = Math.max(1, initialCapacity);
    this.generations = new Uint32Array(this.capacity); // 0 everywhere = never issued
    this.archetypeIds = new Uint32Array(this.capacity).fill(NO_ARCHETYPE);
    this.rows = new Uint32Array(this.capacity).fill(NO_ROW);
  }

  /**
   * Mint a fresh identity: a slot + its current generation, with no placement yet.
   * O(1) — touches only `generations`/`freeList`, which no query iterates (§5.2).
   */
  allocate(): Entity {
    let slot: number;
    if (this.freeList.length > 0) {
      // Reuse a recently-freed slot. Its generation was already bumped at free() time
      // (§5.5 freeIdentity), so it is current and distinct from any stale handle.
      slot = this.freeList.pop() as number;
    } else {
      slot = this.slotCount;
      if (slot >= this.capacity) this.grow(slot + 1);
      this.slotCount++;
      this.generations[slot] = 1; // fresh slot's first generation (0 is reserved)
    }
    this.archetypeIds[slot] = NO_ARCHETYPE;
    this.rows[slot] = NO_ROW;
    return pack(slot, this.generations[slot]);
  }

  /**
   * Free an identity: bump the slot's generation (invalidating the handle), clear its
   * placement, and push the slot onto the free list. Bumping at free-time means a freed
   * slot already carries its next generation while it waits to be reused (§5.5). No-op on a
   * stale or already-freed handle.
   */
  free(e: Entity): boolean {
    if (!this.isAlive(e)) return false;
    const slot = slotOf(e);
    this.bumpGeneration(slot);
    this.archetypeIds[slot] = NO_ARCHETYPE;
    this.rows[slot] = NO_ROW;
    this.freeList.push(slot);
    return true;
  }

  /**
   * Clear the table IN PLACE, keeping slot identity strictly monotonic (R3): bump every LIVE
   * slot's generation so every pre-reset handle reads dead — never aliased to an entity later
   * minted at the same slot — then return every slot to the free list for reuse. Slots already
   * on the free list carry an already-bumped generation and are left as-is. The high-water mark
   * and per-slot generation history are preserved, so a subsequent spawn/import reuses slots via
   * the free-list branch of {@link allocate} (which does NOT re-seed the generation), issuing
   * handles with strictly-greater generations than any stale pre-reset handle.
   */
  reset(): void {
    // Mark which slots are already free; the rest of [0, slotCount) are live (a slot is live iff
    // it is in range and not on the free list — placement alone can't tell them apart, §5.2).
    const onFreeList = new Uint8Array(this.slotCount);
    for (const s of this.freeList) onFreeList[s] = 1;
    this.freeList.length = 0;
    for (let slot = 0; slot < this.slotCount; slot++) {
      if (onFreeList[slot] === 0) this.bumpGeneration(slot); // live slot → invalidate every stale handle
      this.archetypeIds[slot] = NO_ARCHETYPE;
      this.rows[slot] = NO_ROW;
      this.freeList.push(slot);
    }
  }

  /**
   * Advance a slot's generation, wrapping past {@link MAX_GENERATION} (skipping 0 so it stays
   * distinct from "never issued"). The shared invalidation discipline for {@link free} and
   * {@link reset}: past a wrap a stale handle to this slot can alias the live entity — a defined
   * but lossy limit of the 20/12 split (§2), surfaced via a DEV warn (stripped in production).
   */
  private bumpGeneration(slot: number): void {
    let next = this.generations[slot] + 1;
    if (next > MAX_GENERATION) {
      next = 1;
      devWarn(
        `entity slot ${slot} exhausted its ${MAX_GENERATION} generations and wrapped — a stale handle to this slot can now read as alive (ABA). Defined but lossy under the 20/12 handle split (§2).`,
      );
    }
    this.generations[slot] = next;
  }

  /** True if the handle names a currently-live entity (identity-only OR placed) — "not dead". */
  isAlive(e: Entity): boolean {
    const slot = slotOf(e);
    if (slot >= this.slotCount) return false; // never allocated
    return this.generations[slot] === genOf(e);
  }

  /** True only if the entity is placed in an archetype (queryable / component-readable). */
  isPlaced(e: Entity): boolean {
    return this.isAlive(e) && this.archetypeIds[slotOf(e)] !== NO_ARCHETYPE;
  }

  /** True only if the entity is alive but not yet placed (a forward reference; §5.2). */
  isIdentityOnly(e: Entity): boolean {
    return this.isAlive(e) && this.archetypeIds[slotOf(e)] === NO_ARCHETYPE;
  }

  // --- placement accessors (written by the archetype store's place/unplace, §5.5) ---

  /** Current archetype id for a slot, or `NO_ARCHETYPE`. Assumes the slot is live. */
  archetypeOf(slot: number): number {
    return this.archetypeIds[slot];
  }

  /** Current row for a slot, or `NO_ROW`. Assumes the slot is live. */
  rowOf(slot: number): number {
    return this.rows[slot];
  }

  /** Bind a slot to an archetype row (place/migrate). */
  setPlacement(slot: number, archetypeId: number, row: number): void {
    this.archetypeIds[slot] = archetypeId;
    this.rows[slot] = row;
  }

  /** Only update a slot's row (used by swap-and-pop's moved-entity fixup, §5.5). */
  setRow(slot: number, row: number): void {
    this.rows[slot] = row;
  }

  /** Clear a slot's placement back to identity-only. */
  clearPlacement(slot: number): void {
    this.archetypeIds[slot] = NO_ARCHETYPE;
    this.rows[slot] = NO_ROW;
  }

  /** The current generation for a slot (for reconstructing a live handle). */
  generationOf(slot: number): number {
    return this.generations[slot];
  }

  /** The live handle currently occupying a slot. Only meaningful for a live slot. */
  entityAt(slot: number): Entity {
    return pack(slot, this.generations[slot]);
  }

  /** Number of live entities (allocated minus freed). */
  get liveCount(): number {
    return this.slotCount - this.freeList.length;
  }

  /** High-water mark of allocated slots (the domain tag bitsets / columns must cover). */
  get highWaterMark(): number {
    return this.slotCount;
  }

  /** Grow the backing arrays to hold at least `min` slots (geometric doubling), preserving data. */
  private grow(min: number): void {
    if (min > MAX_SLOTS) {
      throw new Error(
        `strata: entity slot capacity exceeded — a document may hold at most ${MAX_SLOTS} live entities with the current 20/12 handle split (§2).`,
      );
    }
    let cap = this.capacity;
    while (cap < min) cap *= 2;
    if (cap > MAX_SLOTS) cap = MAX_SLOTS;

    const generations = new Uint32Array(cap);
    generations.set(this.generations);
    const archetypeIds = new Uint32Array(cap).fill(NO_ARCHETYPE);
    archetypeIds.set(this.archetypeIds);
    const rows = new Uint32Array(cap).fill(NO_ROW);
    rows.set(this.rows);

    this.generations = generations;
    this.archetypeIds = archetypeIds;
    this.rows = rows;
    this.capacity = cap;
  }
}
