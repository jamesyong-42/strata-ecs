/**
 * Tag storage — one slot-indexed bitset per tag type (design §3.2).
 *
 * A tag is a zero-sized marker kept OUTSIDE archetype identity: `bitsets[tagId]` is a
 * `Uint32Array` with one bit per entity **slot** (§2). Because slots never change when an
 * entity migrates archetype, tag toggles are O(1) and migration-invariant.
 *
 * The public generation guard lives on `RuntimeStore.hasTag` — this store is slot-addressed
 * and unguarded; callers pass a slot only after validating the handle (§3.2).
 */

import type { TagId } from "./schema";

export class TagStore {
  private readonly bitsets = new Map<TagId, Uint32Array>();

  /** Set the bit for `slot` in tag `tagId`, growing the bitset if needed. */
  set(tagId: TagId, slot: number): void {
    const b = this.ensure(tagId, slot);
    b[slot >>> 5] |= 1 << (slot & 31);
  }

  /** Clear the bit for `slot` in tag `tagId` (no-op if the bitset doesn't reach that slot). */
  clear(tagId: TagId, slot: number): void {
    const b = this.bitsets.get(tagId);
    const w = slot >>> 5;
    if (b !== undefined && w < b.length) b[w] &= ~(1 << (slot & 31));
  }

  /** Whether `slot`'s bit is set in tag `tagId`. Unguarded — the caller validates the handle. */
  has(tagId: TagId, slot: number): boolean {
    const b = this.bitsets.get(tagId);
    if (b === undefined) return false;
    const w = slot >>> 5;
    if (w >= b.length) return false;
    return ((b[w] >>> (slot & 31)) & 1) === 1;
  }

  /**
   * Clear `slot`'s bit in EVERY tag bitset. Called on despawn so a reused slot never inherits
   * the previous occupant's tags — a correctness requirement, since bitsets carry no generation
   * (§3.2, §5.5).
   */
  clearAll(slot: number): void {
    const w = slot >>> 5;
    const mask = ~(1 << (slot & 31));
    for (const b of this.bitsets.values()) {
      if (w < b.length) b[w] &= mask;
    }
  }

  /** The raw bitset for a tag, or `undefined` if none has been created (for query row-probes, §6). */
  bitset(tagId: TagId): Uint32Array | undefined {
    return this.bitsets.get(tagId);
  }

  private ensure(tagId: TagId, slot: number): Uint32Array {
    const wordsNeeded = (slot >>> 5) + 1;
    let b = this.bitsets.get(tagId);
    if (b === undefined) {
      b = new Uint32Array(Math.max(wordsNeeded, 4));
      this.bitsets.set(tagId, b);
      return b;
    }
    if (b.length < wordsNeeded) {
      const grown = new Uint32Array(Math.max(wordsNeeded, b.length * 2));
      grown.set(b);
      this.bitsets.set(tagId, grown);
      return grown;
    }
    return b;
  }
}
