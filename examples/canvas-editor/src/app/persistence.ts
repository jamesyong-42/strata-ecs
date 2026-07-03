/**
 * Persistence — strata's built-in whole-world serialization doing the whole job:
 * `world.export()` → bytes (UTF-8 JSON) → localStorage autosave + .json file download, and
 * back via `world.import()`. No rival JS ECS ships this at all.
 *
 * THE RESTORE DISCIPLINE (R3): restore loads IN PLACE via `world.import(bytes, { replace: true })`
 * — one stable World for the app's life, no swap. The import validates the snapshot BEFORE it
 * resets, so an incompatible board (schema drift) throws with the current document intact; on
 * success it frees every prior entity WITH a generation bump, so any handle minted before the
 * restore reads dead — never the silent ALIAS a fresh-world swap invited (both worlds used to mint
 * the same slot/gen sequence). The in-flight gesture is still cancelled FIRST (its draft shape dies
 * with the reset); app-side mirrors (stats, camera) are then rebuilt from the loaded world. The
 * observer panel and the reactive repaint watch SURVIVE the restore (they belong to the stable
 * World), so `onRestore` only re-syncs chrome the snapshot changed (the sim toggle) — not
 * re-subscriptions.
 *
 * Autosave is debounced off the mutation funnel, runs on requestIdleCallback, and DEFERS
 * while a gesture is active — export is O(document) and must never hitch a drag (§8.3).
 * A boot-restore can never brick the app: an incompatible autosave (the schema evolves —
 * this example exists to drive framework development) is quarantined and reseeded over.
 */

import { renderable } from "../ecs/queries";
import { Camera as CameraRes, Gesture, ZIndex } from "../ecs/schema";
import { cam, syncCameraResource } from "./camera";
import { stats } from "./commands";
import { cancelGesture, gestureActive } from "./tools";
import { world } from "./worldRef";

const LS_KEY = "strata-canvas:autosave";
const LS_QUARANTINE = "strata-canvas:autosave-incompatible";
const AUTOSAVE_DEBOUNCE_MS = 800;
// Ceiling on how long the trailing debounce may be pushed out before a save is forced.
const AUTOSAVE_MAX_WAIT_MS = 10_000;

let saveTimer: number | undefined;
let idlePending = false;
let lastSaveAt = performance.now();
const restoreListeners: (() => void)[] = [];

export function onRestore(fn: () => void): void {
  restoreListeners.push(fn);
}

export function scheduleAutosave(): void {
  // Max-wait ceiling on the trailing debounce. Under reactivity the autosave hook fires far
  // more often than before: while the sim runs, Integrate stamps Position every frame, the
  // Tier-1 renderable observer fires every notify(), and this is called every frame — a pure
  // trailing debounce would be pushed out forever and never save. Once >MAX_WAIT has elapsed
  // since the last successful save, stop resetting and let the already-pending timer fire.
  if (saveTimer !== undefined && performance.now() - lastSaveAt > AUTOSAVE_MAX_WAIT_MS) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const run = (): void => {
      idlePending = false;
      // never export inside a gesture — a multi-ms world walk would hitch the drag (§8.3)
      if (gestureActive()) {
        scheduleAutosave();
        return;
      }
      if (!saveToLocalStorage()) {
        // over quota: clear rather than keep a STALE autosave that would silently roll the
        // board back on the next reload; the file download path still works at any size
        clearAutosave();
        console.warn("strata-canvas: autosave skipped (localStorage quota) — stale autosave cleared.");
      }
    };
    if ("requestIdleCallback" in window) {
      idlePending = true;
      requestIdleCallback(run, { timeout: 2000 });
    } else {
      run();
    }
  }, AUTOSAVE_DEBOUNCE_MS);
}

// flush pending work when the tab goes away — export is synchronous and small at editor scale
window.addEventListener("pagehide", () => {
  if (saveTimer !== undefined || idlePending) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    idlePending = false;
    if (!gestureActive()) saveToLocalStorage();
  }
});

export function saveToLocalStorage(): boolean {
  try {
    const bytes = world.export();
    localStorage.setItem(LS_KEY, new TextDecoder().decode(bytes));
    lastSaveAt = performance.now(); // resets the max-wait clock for every real save path
    return true;
  } catch {
    return false; // quota — a 100k-shape board is a multi-MB JSON string
  }
}

export function hasAutosave(): boolean {
  return localStorage.getItem(LS_KEY) !== null;
}

export type AutosaveLoad = "restored" | "incompatible" | "none";

/** Boot-safe: an autosave that no longer imports (schema drift, corruption) is quarantined
 *  and reported — it must NEVER brick the boot, which would retry the throw on every load. */
export function loadAutosave(): AutosaveLoad {
  const s = localStorage.getItem(LS_KEY);
  if (s === null) return "none";
  try {
    restore(new TextEncoder().encode(s));
    return "restored";
  } catch (err) {
    try {
      localStorage.setItem(LS_QUARANTINE, s);
    } catch {
      /* quota — the quarantine copy is best-effort */
    }
    clearAutosave();
    console.warn("strata-canvas: autosave incompatible with the current schema — reseeding.", err);
    return "incompatible";
  }
}

export function clearAutosave(): void {
  localStorage.removeItem(LS_KEY);
}

/** Download the document as a .json file (the snapshot IS readable JSON, §8.1). */
export function downloadDoc(): void {
  const bytes = world.export();
  const blob = new Blob([bytes as BlobPart], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "strata-canvas.json";
  a.click();
  URL.revokeObjectURL(url);
}

export async function loadDocFile(file: File): Promise<void> {
  restore(new Uint8Array(await file.arrayBuffer()));
}

/** Load a snapshot IN PLACE (R3): cancel the gesture, `import({ replace: true })` into the stable
 *  world, rebuild app-side mirrors, notify chrome. Throws if the bytes don't import — and because
 *  the import validates before it resets, a throw leaves the current board untouched (callers own
 *  the failure UX: boot quarantines, the file-open button toasts). */
export function restore(bytes: Uint8Array): void {
  // FIRST — an in-flight draw's draft dies with the reset; cancel it in the world it belongs to so
  // no gesture handle is left dangling (dead, never aliased — R3's in-place generation bump).
  cancelGesture();

  // Reset-in-place + import in one call. Validates before touching the world, so incompatible
  // bytes throw here with the document intact (the quarantine + file-open failure paths rely on it).
  world.import(bytes, { replace: true });

  // a snapshot saved mid-gesture must not inject a live gesture into the restored world
  world.setResource(Gesture, { mode: "idle", dx: 0, dy: 0 });

  // rebuild the app-side mirrors from the loaded world (read-only walk)
  let n = 0;
  let maxZ = 0;
  world.query(renderable).each((b) => {
    const zz = b.col(ZIndex).z;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      if (zz[r] > maxZ) maxZ = zz[r];
    }
    n += b.count;
  });
  stats.entities = n;
  stats.zTop = maxZ + 1;

  // the viewport rides in the snapshot too (Camera is a resource) — restore pan/zoom,
  // keep this window's size (w/h are set by the resize handler, not the document)
  const saved = world.getResource(CameraRes);
  if (saved !== undefined) {
    cam.x = saved.x;
    cam.y = saved.y;
    cam.zoom = saved.zoom;
  }

  // No manual first-paint flag: the import's wipe + refill stamped the renderable archetypes, so the
  // surviving Tier-1 observer (reactivity.ts) repaints at the next notify. This write of the Camera
  // resource (window w/h over the snapshot's) also wakes observeResource(Camera) (003 §1.4).
  syncCameraResource();
  for (const fn of restoreListeners) fn();
}
