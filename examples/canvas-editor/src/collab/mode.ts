/**
 * The collab-mode flag + the active session handle.
 *
 * Local-only mode is the default and stays UNCHANGED when `?collab` is absent — `activeCollab()`
 * returns `null` and every op site (editorOps, tools) takes its original `world`-only path. When a
 * `?collab=<room>` boot succeeds it installs the session here, and those same op sites route their
 * DOCUMENT mutations through `doc.transaction` instead (design.md §12). Selection, hover, camera and
 * the rest of interaction state stay runtime-only in BOTH modes — the schema drew that line on day one.
 */

import type { Attachment, DurableStore } from "@vibecook/strata-ecs/durable";
import type { EphemeralStore } from "@vibecook/strata-ecs/ephemeral";

export interface CollabSession {
  readonly room: string;
  /** `crypto.randomUUID()` per tab session — never reused across reloads (006 B5). */
  readonly peerId: string;
  /** The attached durable store: `doc.transaction` is the one way the app changes the shared document. */
  readonly doc: DurableStore;
  /**
   * The durable {@link Attachment} — its `.baseline` seam feeds the observer's DURABLE tab (the
   * un-agreed sync delta, baseline vs converged doc). OPTIONAL so smoke.ts's `setActiveCollab` calls,
   * which install a bare `{ room, peerId, doc }` session, still satisfy the type; only the browser boot
   * (which owns the attachment) supplies it, so the tab shows a placeholder under the self-test.
   */
  readonly attachment?: Attachment;
  /**
   * The presence store's ephemeral handle — its `debugDump()` feeds the observer's EPHEMERAL tab (live
   * per-peer presence blobs). OPTIONAL for the same reason as {@link attachment}: presence only exists in
   * the browser boot, never in the smoke suite's hand-wired sessions.
   */
  readonly eph?: EphemeralStore;
}

let active: CollabSession | null = null;

/** Install (or clear) the active collab session. Called once by the `?collab` boot after attach. */
export function setActiveCollab(session: CollabSession | null): void {
  active = session;
}

/** The active session, or `null` in local-only mode — the op sites branch on this. */
export function activeCollab(): CollabSession | null {
  return active;
}

/** True iff a collab session is active (the terse form for the op-site branches). */
export function isCollab(): boolean {
  return active !== null;
}
