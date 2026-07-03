/**
 * Part II — The Storage Substrate (Patch Note 005).
 *
 * The *vocabulary* Parts III–IV build behavior on: the snapshot ladder interfaces, canonical values
 * + cell equality, the pure `normalizeBatch`, the in-memory baseline, and the projector kernel. No
 * Loro dependency lands here (§9 scope cut) — `CRDTSnapshot` is a frozen interface only.
 *
 * Internal barrel: Parts III/IV import these RELATIVELY. `package.json`/tsup are untouched (Part II
 * is internal surface).
 */

// --- the vocabulary (§1, §7) ---
export type {
  ComponentValue,
  ComponentName,
  TagName,
  RelationName,
  EntityRecord,
  Snapshot,
  MutableSnapshot,
  CRDTSnapshot,
  Origin,
  ChangeEvent,
  ChangeBatch,
} from "./types";

// --- canonical values + cell equality (§2) ---
export { canon, canonResource, scalarEquals, cellEquals, tryCanon } from "./canon";
export type { TryCanonResult } from "./canon";

// --- the pure normalization (§4) ---
export { normalizeBatch } from "./normalize";

// --- the in-memory baseline (§1, §2; M2) ---
export { BaselineSnapshot } from "./baseline";

// --- the projector kernel (§5; M3) ---
export { Projector } from "./projector";
