/**
 * The collab-mode flag + the active session handle.
 *
 * Local-only mode is the default and stays UNCHANGED when `?collab` is absent — `activeCollab()`
 * returns `null` and every op site (editorOps, tools) takes its original `world`-only path. When a
 * `?collab=<room>` boot succeeds it installs the session here, and those same op sites route their
 * DOCUMENT mutations through `doc.transaction` instead (design.md §12). Selection, hover, camera and
 * the rest of interaction state stay runtime-only in BOTH modes — the schema drew that line on day one.
 */

import type { DurableStore } from "strata-ecs/durable";

export interface CollabSession {
  readonly room: string;
  /** `crypto.randomUUID()` per tab session — never reused across reloads (006 B5). */
  readonly peerId: string;
  /** The attached durable store: `doc.transaction` is the one way the app changes the shared document. */
  readonly doc: DurableStore;
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
