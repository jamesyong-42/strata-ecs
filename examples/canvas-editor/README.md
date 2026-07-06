# strata canvas — the flagship example

An infinite-canvas whiteboard built on [strata-ecs](../../README.md)'s Part I runtime core, in
**vanilla TypeScript + Canvas2D**. The only runtime dependency is `@vibecook/strata-ecs` itself — no UI
framework, no renderer library, no state manager. The ECS _is_ the state manager; the frame
is the subscription.

```sh
pnpm install                 # repo root
pnpm example:canvas          # → http://localhost:5173
```

Useful links: `?count=50000` (seed size, ≤100k) · `?sim=1` (boot into simulate) ·
`?obs=systems|timeline` (open the observer on a tab) · `?fresh=1` (skip the autosave).

The example consumes strata-ecs **live from `../../src`** (exact-match vite aliases + tsconfig
paths), so editing the framework hot-reloads the app — this example exists to drive
strata-ecs's development. `STRATA_DIST=1 pnpm --filter @strata-ecs/example-canvas-editor build`
exercises the built dist through the real exports map instead.

## What to try (each maps to a measured framework strength)

| Do this                                                        | What it proves                                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marquee thousands of shapes, drag them                         | tag-filtered dense column writes (`DragMove`) — top-tier iteration, flat cost                                                                                        |
| `+10k` in the HUD                                              | entity lifecycle — strata-ecs's measured benchmark **win** (see the ms toast)                                                                                        |
| Zoom way out                                                   | brute-force full-world culling with **no spatial index**, sub-ms (observer → systems)                                                                                |
| ▶ simulate, then keep editing                                  | a `runIf`-gated phase: zero cost off, dense integration on — zero migrations either way (`Velocity` lives on every shape from birth)                                 |
| Delete a note with arrows                                      | relation cascade — edges die with either endpoint, zero app cleanup                                                                                                  |
| Refresh the tab                                                | `world.export()`/`import()` — built-in whole-world serialization no rival JS ECS ships (autosave + ⤓/⤒ file round-trip; the viewport rides in the `Camera` resource) |
| Click a shape in the observer's entities tab                   | live component/tag/relation reflection; watch `Selected` blink as you click                                                                                          |
| Untick `Cull` (or `cull test`) in the HUD                      | the schedule is a plain array — and self-inflicted jank shows what the sweep saves                                                                                   |
| Open the console and watch nothing repaint at idle — then drag | the repaint is driven by `world.reactive.observeQuery`, not hand-set dirty flags                                                                                     |

The **observer panel** (top right) is not app code — it's `@vibecook/strata-ecs/tools`, the framework's
own dev tool, mounted with one call and an app-supplied labeling callback
(`attachObserver(world, { describe })`).

## Collab mode — the same editor, multiplayer (`?collab`)

Add `?collab` (or `?collab=<room>`) to the URL and open the page in **two tabs**. By default there is
**no server**: a `BroadcastChannel("strata-collab:<room>")` between same-origin tabs is the whole
transport. The first tab seeds the board into a shared document; the second broadcasts a `hello`
and bootstraps from a snapshot, then both edit **one live document**. (Add `?ws` to run the same thing
across **machines** over a real WebSocket relay instead of tabs — see [below](#across-machines--the-websocket-relay-ws).)

```sh
pnpm example:canvas
# open http://localhost:5173/?collab=demo   ← then duplicate the tab
```

**What to try (two tabs, side by side):**

| Do this                                               | What you see — and who owns it                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both tabs grab the **same shape** and drag it at once | your drag holds locally while the other tab's edits to that same cell are held OFF; on release both tabs **converge** on the last committer's position (**drag protection**, design §18.5) |
| Drag a shape in tab A while tab B **deletes** it      | the delete converges; your drag ends against a shape that's gone, cleanly — no dangling handle, arrows cascade on both tabs                                                                |
| Edit a shape's **fill** in A while B **drags** it     | both land — fill and position are **separate components**, so they never contend (component-granular convergence, §13.4)                                                                   |
| Move your mouse; watch the **other tab**              | a labeled **remote cursor** tracks you live; select a shape and a colored **selection outline** appears in the other tab (presence — ephemeral, self-expiring on TTL)                      |
| Watch the green **sync chips** in the HUD             | `room · peers N · pending/held/applied` — updated only when something actually changes (set-on-change; an idle room posts zero updates)                                                    |
| Close one tab                                         | its cursor + selection vanish in the other within a moment (`leave()` on `pagehide`, or the TTL as the guarantee)                                                                          |

**What the app owns vs. what the framework owns.** The app owns exactly two small, labeled things:
the **transport** (`collab/transport.ts` — four envelope kinds, zero conflict code — behind which sits
either a `BroadcastChannel` or the `collab/transport-ws.ts` WebSocket relay client, chosen by `?ws`) and
the **bootstrap policy** (`collab/boot.ts` — the hello/snapshot handshake, the seed-vs-join decision, and
the reconnect re-bootstrap). Everything hard is the framework's: **convergence** (committer-wins,
drag-protected, component-granular) lives behind `doc.applyRemote`; **presence** (writer-partitioned
cursors that project as `Not(Local)` entities and self-expire) is `@vibecook/strata-ecs/ephemeral`. There is no
manual dirty tracking, no conflict-resolution code, and no presence protocol anywhere in this
example — their **absence** is the demo. Undo is **local-ops-only** by construction in the durable
layer (proven in the framework's durable suite); the example doesn't yet bind a key to it.

**Two caveats.** (1) **Local file save/open (⤓/⤒) are disabled in collab mode**: the shared document
lives only in the live session — there is no autosave and no localStorage (opening a `.json` would
`world.import(replace)` the collab world out from under the attached durable binding, diverging the
runtime from the document it mirrors). The buttons notify instead of acting. (2) The example does not
bind an **undo** key: `undo` is local-ops-only and framework-proven, but it lives on the durable
adapter, not the public `DurableStore` surface, so wiring a verb is deferred.

### Across machines — the WebSocket relay (`?ws`)

Same editor, same document, but the bytes cross **machines** instead of tabs. Start the relay, then open
the page with `?ws` on two browsers (or two computers on a LAN):

```sh
pnpm collab:server                       # the relay — ws://localhost:8787 (PORT overrides)
pnpm example:canvas                       # the app, in another terminal

# same machine, two browser windows:
#   http://localhost:5173/?collab=demo&ws
# two machines on a LAN — the relay's host is 192.168.1.5, say:
#   http://<that-host>:5173/?collab=demo&ws=ws://192.168.1.5:8787
```

`?ws` (bare) points at `ws://localhost:8787`; `?ws=<origin>` overrides the host. The room rides in the URL
path (`ws://host:8787/<room>`). No `?ws` param = the BroadcastChannel transport, unchanged.

**What the relay is — and deliberately is not.** It is a **dumb byte-relay** (`examples/collab-server/`,
~100 lines, one dep: `ws`): it routes by room and broadcasts each frame to the OTHER members of that room,
verbatim. It **never decodes a frame**, holds **no document state**, runs **no CRDT**, and resolves **no
conflicts** — peers bootstrap each other over the app's own `hello`→`snapshot` protocol, and convergence
is the framework's, behind `doc.applyRemote`, exactly as with BroadcastChannel. A second transport behind
the same envelope interface, with the relay knowing nothing about the payload, is the point: it shows the
transport seam is real (`collab/transport-ws.ts` is the whole client; the framework is untouched).

**Reconnect = full re-bootstrap.** A dropped socket may have dropped increments, which would risk a
quarantine on both sides — so the policy (mandated by patch note 006 §A4/§C7) is NOT to resume a
half-synced stream. On close the client drops back to un-bootstrapped and buffers; it reconnects with
exponential backoff (capped ~5s); on reopen it re-runs the whole **bidirectional** bootstrap (`hello` +
its own snapshot; peers respond; buffered inbound drains after). Edits made while disconnected ride the
reconnect snapshot, not a lost increment. Presence needs nothing special — a peer's cursor expires on TTL
while it is gone and reappears via the ephemeral keepalive once it is back. Kill the relay mid-edit and
restart it: both peers re-bootstrap and re-converge, cursors and all.

`?script=collab-smoke` runs the whole story headlessly as an **acceptance suite** in one page. Peer A is
the app's own world driving the REAL collab write ops (`commitCreate`/`commitDelete`/`commitDuplicate`/
`commitDrag`); peers B and C are plain worlds over an in-memory loopback. It asserts precise convergence
(shape counts, component values, keys resolving) across: bootstrap, create, duplicate, delete,
edit-vs-drag (component-granular + drag protection + committer-wins), delete-under-drag (§17), a late
joiner bootstrapping mid-history + the bidirectional-base exchange, and presence (cursor + selection
projection, `leave()`). The whole suite runs under BOTH loopback modes — **sync** (inline, deterministic)
and **async** (microtask-deferred, realistic BroadcastChannel timing) — and reports
`PASS n/n (sync) · n/n (async)` to the HUD note. Add **`&transport=ws`** to run the SAME suite through the
live relay instead (both in-page worlds open their own socket to it), plus a relay-drop → re-bootstrap
scenario — it reports `PASS n/n` and needs the server running.

```sh
pnpm example:canvas   # then open http://localhost:5173/?script=collab-smoke
# over the real socket (start `pnpm collab:server` first):
#   http://localhost:5173/?script=collab-smoke&transport=ws
```

## Architecture — a file per lesson

```
src/
  ecs/                          the world's vocabulary + behavior
    schema.ts                     every define* call (ONE module: the registry is
                                  process-global; HMR-guarded → full reload). Split
                                  DOCUMENT CONTENT vs INTERACTION STATE — that line is
                                  where Part III (durable/collab) later attaches. §4, §11.1
    queries.ts                    compiled queries as module constants                  §6
    systems/cull.ts               brute-force viewport sweep → app-side DrawBuffer
                                  (never a per-frame Visible tag — measured weak path)
    systems/dragMove.ts           the flagship gesture: selection-wide column writes    §5.1
    systems/integrate.ts          Integrate → Bounce; same-phase order is load-bearing  §7.2
    pipeline.ts                   the schedule as a VALUE — rebuilt live by HUD toggles §7
  app/                          the editor around the world
    worldRef.ts                   THE single, stable World (restore clears it in place, R3)
    frameLoop.ts                  sync() → tick() → paint, ecs/paint split measured     §16.2
    commands.ts                   the mutation funnel: autosave hook + future undo/tx seam
                                  (change detection moved out — see reactivity.ts)
    reactivity.ts                 the ONE Tier-1 observeQuery that drives repaint + autosave;
                                  the world is the change detector (§002 reactivity)
    tools.ts                      tools as state machines; preview per-frame, COMMIT
                                  once at gesture end (the future doc.transaction spot) §18.5
    input.ts                      DOM events → world-space → active tool, between frames §18.4
    hitTest.ts                    brute-force point/region tests; collect-then-mutate   §16
    editorOps.ts                  selection (Selected tag = the truth), delete, duplicate
    sim.ts / stress.ts            simulate toggle, +10k waves, clear board
    describe.ts                   the app-supplied labeling the observer panel renders
    persistence.ts                export/import, autosave, the in-place restore discipline §8
    camera.ts / seed.ts           infinite viewport math · deterministic clustered board
  render/
    drawBuffer.ts                 packed typed-array draw list (chunk-scoped Batch data
                                  is copied out inside each(), never retained)          §6.2
    contentLayer.ts               dirty-gated Canvas2D + LOD (greeked text far out)
    overlayLayer.ts               every-frame indicators (the dual-canvas pattern)
  ui/                           hand-rolled chrome
    toolbar.ts · hud.ts           tools/save/open · sparkline, stress, jank toggles
```

Three rules hold the boundaries (violating any of them is how ECS apps rot):

1. **Document mutation still flows through `commands.ts`** (the autosave / undo /
   `doc.transaction` seam), but **change detection is now the framework's**: one Tier-1
   `world.reactive.observeQuery` in `app/reactivity.ts` drives both repaint and autosave —
   the world is the change detector, not a hand-raised dirty flag. (See `docs/002-reactivity.md`.)
2. **Systems are the only users of `ctx`**; per-frame math lives in systems; `Batch`
   rows/columns are consumed inside `each()` and never retained.
3. **Rendering is imperative, after `tick()` returns**, from the draw buffer — never a
   per-shape DOM node.

## Honesty notes

The HUD splits **ecs** vs **paint** time because Canvas2D is the bottleneck long before the
ECS is — at extreme zoom-out with LOD off, blame the 2D canvas, not the world. There is no
spatial index anywhere in this example _on purpose_: at editor scale, the typed-array
column sweep does what an R-tree usually does, and the observer's systems tab proves it
live. Undo/redo is deliberately absent from the MVP — it arrives with Part III, where one
`doc.transaction` = one undo entry; the `commands.ts` funnel is the prepared seam.
