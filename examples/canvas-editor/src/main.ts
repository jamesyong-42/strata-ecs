/**
 * Entry point. Boot order: seed the world → wire canvases + chrome + input → start the
 * frame loop. Shareable stress links: ?count=50000 (clamped to [100, 100000] — well under
 * strata's 2^20 entity-slot ceiling; the Canvas2D paint budget is the real limit, and the
 * HUD's ecs/paint split shows exactly which one you're hitting).
 *
 * ?script=demo runs a scripted marquee → drag → duplicate sequence (used by the headless
 * verification screenshots; also a handy smoke test after refactors).
 */

import { attachObserver, type ObserverOptions } from "@vibecook/strata-ecs/tools";
import { cam, panBy, setViewportSize, zoomToFit } from "./app/camera";
import { dirty, setOnMutate, stats } from "./app/commands";
import { duplicateSelection, setSelection } from "./app/editorOps";
import { describeShape } from "./app/describe";
import { startFrameLoop } from "./app/frameLoop";
import { hitTestPoint, hitTestRegion } from "./app/hitTest";
import { attachInput } from "./app/input";
import {
  hasAutosave,
  loadAutosave,
  onRestore,
  saveToLocalStorage,
  scheduleAutosave,
} from "./app/persistence";
import { wireReactivity } from "./app/reactivity";
import { seedBoard } from "./app/seed";
import { isSimOn, setSimBound, setSimulate } from "./app/sim";
import { clearBoard, stressSpawn } from "./app/stress";
import { interaction, pointerDown, pointerMove, pointerUp, setTool } from "./app/tools";
import { world } from "./app/worldRef";
import { startCollabBoot } from "./collab/boot";
import { activeCollab } from "./collab/mode";
import { injectDemoCursors, runCollabSmoke } from "./collab/smoke";
import { buildPipeline, SYSTEM_NAMES, type SystemName } from "./ecs/pipeline";
import { cullFlags } from "./ecs/systems/cull";
import { ContentLayer, lodFlags } from "./render/contentLayer";
import { drawBuffer } from "./render/drawBuffer";
import { OverlayLayer } from "./render/overlayLayer";
import { Hud } from "./ui/hud";
import { buildToolbar } from "./ui/toolbar";

const params = new URLSearchParams(location.search);
const count = Math.min(100_000, Math.max(100, Number(params.get("count") ?? 10_000) || 10_000));
// ?collab or ?collab=<room> switches on multiplayer (default room "demo"); null = local-only mode.
const collabRoom = params.has("collab") ? params.get("collab") || "demo" : null;
// ?ws[=<origin>] selects the real WebSocket relay transport (across machines) instead of the
// same-origin BroadcastChannel (tabs). Bare ?ws = "" → ws://localhost:8787; ?ws=<origin> overrides.
// null (no ?ws) keeps the BroadcastChannel transport unchanged.
const wsOrigin = params.has("ws") ? (params.get("ws") ?? "") : null;

const content = document.getElementById("content") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;

const contentLayer = new ContentLayer(content);
const overlayLayer = new OverlayLayer(overlay);

// The schedule is a value — the HUD's checkboxes rebuild it live (schedule-as-data).
const disabledSystems = new Set<SystemName>();
let pipeline = buildPipeline(disabledSystems);

const hud = new Hud(document.getElementById("hud") as HTMLElement, {
  systemNames: SYSTEM_NAMES,
  onSimToggle(on) {
    setSimulate(on);
    notify(
      on
        ? "simulate ON — every shape got a velocity; keep editing"
        : "simulate off — frozen mid-flight",
    );
  },
  onSpawn(n) {
    const r = stressSpawn(n);
    notify(
      r.spawned === 0
        ? `at the ${(100_000).toLocaleString()}-shape cap`
        : `spawned ${r.spawned.toLocaleString()} fully-initialized shapes in ${r.ms.toFixed(1)}ms`,
    );
  },
  onClear() {
    const n = clearBoard();
    notify(`destroyed ${n.toLocaleString()} shapes (relations cascaded)`);
  },
  onSystemToggle(name, enabled) {
    if (enabled) disabledSystems.delete(name as SystemName);
    else disabledSystems.add(name as SystemName);
    pipeline = buildPipeline(disabledSystems); // just a new array — no scheduler, no registration
    dirty.doc = true; // toggling Cull changes what the next paint shows
    notify(`${name} ${enabled ? "re-enabled" : "removed from the pipeline"}`);
  },
  onCullTestToggle(enabled) {
    cullFlags.viewportTest = enabled;
    dirty.doc = true;
    notify(
      enabled
        ? "viewport cull back on"
        : `cull test OFF — painting all ${stats.entities.toLocaleString()} shapes`,
    );
  },
  onLodToggle(enabled) {
    lodFlags.enabled = enabled;
    dirty.doc = true;
    notify(
      enabled ? "LOD on (greeked text far out)" : "LOD OFF — full text + strokes at every zoom",
    );
  },
});
const notify = (msg: string): void => hud.setNote(msg);

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  contentLayer.resize(w, h, dpr);
  overlayLayer.resize(w, h, dpr);
  setViewportSize(w, h);
  // Resizing the backing stores CLEARED them — and a cam-equal resize (a DPR-only change, or
  // any event where w/h end up identical) suppresses the Camera observer, so the cleared
  // canvas is exactly the app-state the world can't see: force the repaint (review catch).
  dirty.doc = true;
}
window.addEventListener("resize", fitCanvases);
fitCanvases();

// Boot document. COLLAB MODE (?collab=<room>) bootstraps the SHARED document over BroadcastChannel —
// no autosave, no localStorage, no local seed (the first peer seeds into the document; a joiner syncs a
// snapshot). LOCAL-ONLY MODE (the default, ?collab absent) is UNCHANGED: an explicit ?count= (or
// ?fresh=1) always seeds; otherwise the autosave — world.export() bytes in localStorage — restores the
// last session, viewport included; an incompatible autosave (schema drift) is quarantined, never a brick.
if (collabRoom !== null) {
  startCollabBoot(collabRoom, count, notify, (chips) => hud.setCollabChips(chips), wsOrigin);
  // persistence stays local-only — setOnMutate is deliberately NOT called (no autosave in collab).
} else {
  let booted = false;
  if (!params.has("count") && params.get("fresh") !== "1" && hasAutosave()) {
    const load = loadAutosave();
    if (load === "restored") {
      notify(`restored autosave — ${stats.entities.toLocaleString()} shapes (world.import)`);
      booted = true;
    } else if (load === "incompatible") {
      notify("autosave was incompatible with the current schema — seeded a fresh board");
    }
  }
  if (!booted) {
    const seeded = seedBoard(world, count);
    setSimBound(Math.sqrt(count) * 55 * 1.5); // fit the bounce box to the seeded spread
    notify(
      `seeded ${seeded.count.toLocaleString()} shapes + ${seeded.arrows} arrows in ${seeded.ms.toFixed(1)}ms`,
    );
    zoomToFit();
  }
  setOnMutate(scheduleAutosave); // every document mutation debounces an idle-time export
}
// Wire the single Tier-1 renderable observer that drives repaint + autosave. Called AFTER the
// boot seed so the (unarmed) seed pays no stamping tax — the seeded board's first paint comes
// from commands.ts's initial dirty.doc, not from the observer (registration never back-fires).
wireReactivity();

buildToolbar(document.getElementById("toolbar") as HTMLElement, notify);
attachInput(overlay, notify);
// The framework's own observer panel (strata-ecs/tools): entity inspector, per-system µs,
// lifecycle timeline — the app only supplies the labeling. ?obs=systems|timeline picks the
// starting tab for shareable links.
const obsTab = params.get("obs");
const obsOpts: ObserverOptions = {
  describe: describeShape,
  // `tab` (not defaultTab): a shared ?obs= link must win over this browser's persisted layout. The two
  // collab tabs are shareable too — `?obs=durable` / `?obs=ephemeral` force-open them in collab mode.
  tab:
    obsTab === "systems" ||
    obsTab === "timeline" ||
    obsTab === "entities" ||
    obsTab === "durable" ||
    obsTab === "ephemeral"
      ? obsTab
      : undefined,
  // The collab tabs light up ONLY in collab mode: each getter re-reads the active session per poll and
  // returns null in local-only mode (the tab shows its placeholder). These getters ARE ALSO the
  // compile-time proof that the observer's structural read shapes (ObserverDurableSource /
  // ObserverEphemeralSource, tools/index.ts §0) match the real store classes — the tools package cannot
  // import durable/ephemeral, so this collab example's typecheck is what catches drift. If tsc accepts
  // these, the shapes agree; NO as-casts — a mismatch must surface here, never be papered over.
  durable: () => {
    const s = activeCollab();
    return s?.attachment ? { store: s.doc, attachment: s.attachment } : null;
  },
  ephemeral: () => activeCollab()?.eph ?? null,
};
attachObserver(world, obsOpts); // mounted for the app's life — no dispose (the World never swaps, R3)
// Restore clears the World in place (R3): the observer panel and the reactive repaint watch both
// survive it, so there is nothing to re-attach or re-subscribe. onRestore only re-syncs the chrome
// the snapshot changed — the sim toggle (SimMode rides the snapshot, so a restored storm resumes).
onRestore(() => hud.setSimState(isSimOn()));
startFrameLoop(
  () => pipeline,
  () => contentLayer.paint(drawBuffer),
  () => overlayLayer.paint(),
  (s) => hud.frame(s, overlayLayer.selectedCount),
);

// ?sim=1 boots straight into simulate mode (headless verification / shareable links).
if (params.get("sim") === "1") setSimulate(true);
hud.setSimState(isSimOn()); // boot may have restored (or forced) a running storm

// ?script=persist exercises the full save→clear→restore cycle in-process: export bytes,
// wipe the world, import back IN PLACE (world.import replace, R3) — the same code path the
// autosave boot-restore takes.
// ?script=pan proves the camera→resource→observeResource→repaint chain (003 §1.4) headlessly:
// a programmatic pan long after boot must repaint (the screenshot shows an off-center board);
// a broken chain would leave the zoom-to-fit framing frozen on screen.
if (params.get("script") === "pan") {
  setTimeout(() => {
    panBy(360, 220);
    notify("pan test: panned 360,220 — this frame repainted via observeResource(Camera)");
  }, 600);
}

if (params.get("script") === "persist") {
  setTimeout(() => {
    const before = stats.entities;
    if (!saveToLocalStorage()) {
      notify("persist test ABORTED — export exceeded the localStorage quota (board untouched)");
      return;
    }
    clearBoard();
    const cleared = stats.entities;
    const load = loadAutosave();
    notify(
      load === "restored"
        ? `persist test: saved ${before.toLocaleString()} → cleared ${cleared} → restored ${stats.entities.toLocaleString()} in place`
        : `persist test FAILED at restore (${load})`,
    );
  }, 600);
}

// ?script=collab-smoke runs the collab acceptance self-test in-process (collab/smoke.ts): peer A is
// THIS app world driving the real ops, peer B/C are plain worlds over an in-memory loopback. It runs the
// WHOLE suite under BOTH loopback modes — sync (inline) and async (microtask-deferred, realistic
// BroadcastChannel timing) — and asserts identical final convergence, reporting PASS/FAIL to the HUD note.
// The suite tears its bindings down, so the app's seeded board renders behind the note as local-only again.
if (params.get("script") === "collab-smoke") {
  // &transport=ws runs the SAME suite over a live WebSocket relay (both in-page worlds open their own
  // socket to it) instead of the in-memory loopback, and adds a relay-drop → re-bootstrap scenario. The
  // relay must be running (`pnpm collab:server`); default origin ws://localhost:8787, or ?ws=<origin>.
  const wsSmoke = params.get("transport") === "ws";
  // The verdict is the page's deliverable, but the app's OWN collab boot also posts to the note —
  // its first-peer hello window times out at ~800ms and its "seeded the board" message would STOMP
  // a verdict posted earlier (the fast loopback suite finishes in milliseconds; this looked like a
  // hang for weeks). Two guards: start AFTER the boot's hello window has resolved, and re-assert
  // the verdict once after posting so no straggling status message can bury it.
  const postVerdict = (msg: string): void => {
    notify(msg);
    setTimeout(() => notify(msg), 1500);
  };
  setTimeout(() => {
    void (async () => {
      try {
        if (wsSmoke) {
          const origin = params.has("ws") ? (params.get("ws") ?? "") : "";
          const r = await runCollabSmoke({ kind: "ws", origin });
          if (r.failed.length > 0) console.error("collab-smoke (ws) failing checks:", r.failed);
          postVerdict(
            r.passed === r.total
              ? `collab-smoke (ws): PASS ${r.passed}/${r.total} — live relay · app-ops · late-join · reconnect re-bootstrap all converged`
              : `collab-smoke (ws): FAIL — ${r.passed}/${r.total}${r.firstFail ? ` [${r.firstFail}]` : ""}`,
          );
        } else {
          const s = await runCollabSmoke({ kind: "loopback", mode: "sync" });
          const a = await runCollabSmoke({ kind: "loopback", mode: "async" });
          if (s.failed.length > 0) console.error("collab-smoke (sync) failing checks:", s.failed);
          if (a.failed.length > 0) console.error("collab-smoke (async) failing checks:", a.failed);
          const ok = s.passed === s.total && a.passed === a.total && s.total === a.total;
          postVerdict(
            ok
              ? `collab-smoke: PASS ${s.passed}/${s.total} (sync) · ${a.passed}/${a.total} (async) — app-ops · async-loopback · late-join · presence all converged`
              : `collab-smoke: FAIL — sync ${s.passed}/${s.total}${s.firstFail ? ` [${s.firstFail}]` : ""} · async ${a.passed}/${a.total}${a.firstFail ? ` [${a.firstFail}]` : ""}`,
          );
        }
        // Make two remote cursors visible in the running app (the presence-rendering demo) so the PASS
        // frame shows what a second tab looks like — the two-cursor screenshot.
        injectDemoCursors();
      } catch (err) {
        postVerdict(`collab-smoke: FAIL — threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 1300); // after the app boot's own hello window (~800ms) so its status note lands FIRST
}

// Scripted interaction demo — the same code paths real input drives, minus the DOM events.
if (params.get("script") === "demo") {
  setTimeout(() => {
    const rw = cam.w / 5 / cam.zoom;
    const rh = cam.h / 5 / cam.zoom;
    const hits = hitTestRegion(cam.x - rw, cam.y - rh, cam.x + rw, cam.y + rh);
    setSelection(hits.entities);
    interaction.mode = "drag"; // feed DragMoveSystem exactly like a pointer drag would
    interaction.pendingDx = 260 / cam.zoom;
    interaction.pendingDy = 140 / cam.zoom;
    setTimeout(() => {
      interaction.mode = "dragEnd";
      const d = duplicateSelection();
      // regression check for the review-caught critical: a completed draw gesture must
      // PERSIST its shape (setTool used to cancel-destroy it at commit)
      const dx = cam.x - (cam.w / 2 - 60) / cam.zoom;
      const dy = cam.y - (cam.h / 2 - 160) / cam.zoom;
      setTool("rect");
      pointerDown({ sx: 0, sy: 0, wx: dx, wy: dy, shift: false });
      pointerMove(
        { sx: 0, sy: 0, wx: dx + 180 / cam.zoom, wy: dy + 120 / cam.zoom, shift: false },
        180,
        120,
      );
      pointerUp({ sx: 0, sy: 0, wx: dx + 180 / cam.zoom, wy: dy + 120 / cam.zoom, shift: false });
      const drawn = hitTestPoint(dx + 90 / cam.zoom, dy + 60 / cam.zoom);
      notify(
        `demo: marquee ${hits.entities.length.toLocaleString()} → drag → dup ${d.count.toLocaleString()} in ${d.ms.toFixed(1)}ms · draw persisted: ${drawn !== undefined ? "YES" : "NO"}`,
      );
    }, 400);
  }, 400);
}
