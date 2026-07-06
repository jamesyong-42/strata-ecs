/**
 * The frame's draw list — a set of parallel typed-array lanes filled by CullSystem inside
 * its `each()` callback (Batch rows/columns are chunk-scoped and must never be retained;
 * copying the visible rows out here is the contract-respecting way to hand them to paint).
 *
 * Deliberately NOT a `Visible` tag: bulk per-frame tag toggling is strata's measured weak
 * path, a dense column sweep into an app-side buffer is its measured strength. The buffer's
 * absence of a spatial index IS the demo — the HUD shows the full-world sweep staying sub-ms.
 */

import type { Entity } from "@vibecook/strata-ecs";

export class DrawBuffer {
  count = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  w = new Float32Array(0);
  h = new Float32Array(0);
  /** 0xRRGGBBAA packed fill. */
  color = new Uint32Array(0);
  /** Kind discriminant (1 rect · 2 ellipse · 3 note). */
  kind = new Uint8Array(0);
  z = new Int32Array(0);
  /** Entity handle — paint uses it for capped `readField` label reads on visible notes. */
  entity = new Uint32Array(0);
  /** Indices 0..count-1 sorted by z, filled by sortByZ() after the cull sweep. */
  order = new Uint32Array(0);

  private capacity = 0;

  reset(): void {
    this.count = 0;
  }

  /** Grow all lanes to hold at least `n` commands (amortized doubling). */
  ensure(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(1024, 1 << Math.ceil(Math.log2(n)));
    const grow = <T extends Float32Array | Uint32Array | Uint8Array | Int32Array>(
      old: T,
      make: (len: number) => T,
    ): T => {
      const next = make(cap);
      next.set(old as never);
      return next;
    };
    this.x = grow(this.x, (l) => new Float32Array(l));
    this.y = grow(this.y, (l) => new Float32Array(l));
    this.w = grow(this.w, (l) => new Float32Array(l));
    this.h = grow(this.h, (l) => new Float32Array(l));
    this.color = grow(this.color, (l) => new Uint32Array(l));
    this.kind = grow(this.kind, (l) => new Uint8Array(l));
    this.z = grow(this.z, (l) => new Int32Array(l));
    this.entity = grow(this.entity, (l) => new Uint32Array(l));
    this.order = grow(this.order, (l) => new Uint32Array(l));
    this.capacity = cap;
  }

  push(
    x: number,
    y: number,
    w: number,
    h: number,
    color: number,
    kind: number,
    z: number,
    entity: Entity,
  ): void {
    const i = this.count;
    this.ensure(i + 1);
    this.x[i] = x;
    this.y[i] = y;
    this.w[i] = w;
    this.h[i] = h;
    this.color[i] = color;
    this.kind[i] = kind;
    this.z[i] = z;
    this.entity[i] = entity;
    this.count = i + 1;
  }

  private sortKeys = new Float64Array(0);

  /** Sort the visible set back-to-front by explicit z (never by iteration order — row order
   *  is unstable under swap-and-pop). Packs `(z + 2³¹)·2²⁰ + index` into one float and uses
   *  the comparator-LESS typed-array sort — a JS comparator costs ~25ms at 100k visible,
   *  paid on every painted frame; the packed numeric sort is several times cheaper. */
  sortByZ(): void {
    const n = this.count;
    if (this.sortKeys.length < this.capacity) this.sortKeys = new Float64Array(this.capacity);
    const keys = this.sortKeys;
    const z = this.z;
    for (let i = 0; i < n; i++) keys[i] = (z[i] + 2147483648) * 1048576 + i; // exact ≤ 2⁵², i < 2²⁰
    keys.subarray(0, n).sort();
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = keys[i] % 1048576;
  }
}

/** The app-wide draw buffer singleton (one frame in flight at a time). */
export const drawBuffer = new DrawBuffer();
