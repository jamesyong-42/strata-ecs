/**
 * `DurableSyncStatus` — the durable layer's runtime-local sync-status resource (Part III **M5**;
 * design.md §15.7 / 006 C7 as amended).
 *
 * A framework-defined resource (the `Local`-tag precedent: framework-exported, the binding writes it).
 * It is a **runtime-local** resource — NEVER written to the document, NEVER itself durable: the binding
 * publishes it through `world.setResource` at sync-activity boundaries only, so a React panel reads it
 * with `useResource(world, DurableSyncStatus)` and re-renders exactly when sync activity changes.
 *
 * Every field is **activity-driven** (006 C7's mandate — the whole point of the amendment): an IDLE
 * network must produce ZERO re-renders, even though `world.sync()` drains unconditionally each frame.
 * That guarantee rides two mechanisms in the binding (durable/binding.ts): (1) these fields only move on
 * real activity — `lastAppliedFrame` advances ONLY when a drain applied ≥1 fact, never per-drain; and
 * (2) **producer-side set-on-change** — the binding compares each field against the last value it set and
 * SKIPS `setResource` when nothing changed, so an empty drain never stamps and never re-renders.
 */

import { defineResource } from "../core";

/**
 * The runtime-local sync-status resource (006 C7). Fields, all flat activity-driven scalars:
 * - `pendingInbound` — queued undrained `ChangeBatch`es (remote + local echoes), measured at enqueue.
 * - `heldCells` — the size of the held-cell ledger (components + resources, 006 C5).
 * - `lastAppliedFrame` — advances ONLY when a drain applied ≥1 fact (never a bumps-every-drain field).
 */
export const DurableSyncStatus = defineResource("DurableSyncStatus", {
  pendingInbound: "u32",
  heldCells: "u32",
  lastAppliedFrame: "f64",
});

/** The value shape of {@link DurableSyncStatus} — the object the binding sets and `useResource` returns. */
export interface DurableSyncStatusValue {
  pendingInbound: number;
  heldCells: number;
  lastAppliedFrame: number;
}
