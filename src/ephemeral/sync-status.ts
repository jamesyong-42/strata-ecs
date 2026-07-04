/**
 * `EphemeralSyncStatus` — the ephemeral layer's runtime-local sync-status resource (Part IV **M2**;
 * design.md §15.7 / 006 C7 as amended + Part III's `DurableSyncStatus` as-built precedent).
 *
 * The ephemeral twin of {@link "../durable/sync-status".DurableSyncStatus}: a framework-defined,
 * **runtime-local** resource (the `Local`-tag precedent — framework-exported, the binding writes it).
 * NEVER transmitted, NEVER itself ephemeral — the binding publishes it through `world.setResource` at
 * inbound-projection boundaries only, so a React panel reads it with `useResource(world,
 * EphemeralSyncStatus)` and re-renders exactly when presence activity changes.
 *
 * Both fields are **activity-driven** (006 C7's mandate): an idle network must produce ZERO re-renders,
 * even though `world.sync()` drains the ephemeral source unconditionally each frame. That rides two
 * mechanisms in the binding (ephemeral/attach.ts): (1) the fields only move on real projection —
 * `lastInboundFrame` advances ONLY when a drain projected ≥1 fact, and `peerCount` is recomputed from the
 * live projection; and (2) **producer-side set-on-change** — the binding compares each field against the
 * last value it set and SKIPS `setResource` when nothing changed, so an idle drain never stamps.
 */

import { defineResource } from "../core";

/**
 * The runtime-local ephemeral sync-status resource (006 C7). Two flat activity-driven scalars:
 * - `peerCount` — distinct REMOTE peer prefixes with ≥1 live projected entity (NOT a per-entity list;
 *   the peer LIST stays a `[PresenceInfo, Not(Local)]` query — 006 C7). Recomputed each drain from the
 *   blob-diff cache's keys.
 * - `lastInboundFrame` — a MONOTONIC per-applied-drain counter, bumped ONLY when a drain projected ≥1
 *   fact (never per-drain, so an idle network leaves it fixed). `f64` (not `u32`) so a long-lived,
 *   sync-heavy session never wraps — matching `DurableSyncStatus.lastAppliedFrame`'s as-built form.
 */
export const EphemeralSyncStatus = defineResource("EphemeralSyncStatus", {
  peerCount: "u16",
  lastInboundFrame: "f64",
});

/** The value shape of {@link EphemeralSyncStatus} — the object the binding sets and `useResource` returns. */
export interface EphemeralSyncStatusValue {
  peerCount: number;
  lastInboundFrame: number;
}
