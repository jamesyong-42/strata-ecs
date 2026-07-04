# Collab Demo Plan — the canvas editor goes multiplayer

**Goal:** the flagship `examples/canvas-editor` gains a `?collab=<room>` mode: two browser tabs
editing ONE document live — durable shapes (drag/draw/delete converging, committer-wins, undo
local-only) + ephemeral presence (live remote cursors + selection highlights) — with zero server:
**BroadcastChannel** is the transport. This is the payoff demo for Parts II–IV; it must make the
framework shine and stay honest about what the app owns (transport, bootstrap policy) vs what the
framework owns (convergence, reconcile, presence).

## Locked decisions

- **Transport:** one `BroadcastChannel("strata-collab:<room>")`, message envelopes
  `{ kind: "durable" | "ephemeral" | "hello" | "snapshot", from: peerId, bytes?/to? }`.
  Durable outbound rides `doc.subscribeOutbound`; inbound → `doc.applyRemote`. Ephemeral outbound
  is the store's `send` callback; inbound → the adapter's `apply`. The app owns the channel —
  exactly design §14.2's split.
- **Late-joiner bootstrap (the M1 lesson: increments presuppose the causal base — a fresh
  receiver quarantines on a bare increment):** joiner broadcasts `hello`; any existing peer
  responds with a full durable snapshot addressed `to` the joiner; the joiner imports the FIRST
  snapshot it receives, then applies live increments. Increments arriving BEFORE the snapshot are
  buffered by the app until bootstrap completes (never fed to `applyRemote` first — the
  `PendingImportError` quarantine is the framework's backstop, not the happy path). No peers
  answering within ~800ms → you are the first peer → seed the board and mark bootstrapped.
  If the store lacks a public full-snapshot export, add ONE minimal method
  (`DurableStore.exportSnapshot(): Uint8Array`, delegating to the adapter's `export()`) — a
  legitimate §14.2 transport-wiring surface; record it in the 006 addendum.
- **peerId:** `crypto.randomUUID()` per tab session (006 B5 — never reuse across reloads).
- **Document ops go through `doc.transaction` in collab mode:** create/delete/duplicate commit
  immediately; **drags stay runtime-writes every frame and commit ONCE at gesture end** (the
  §18.5 architecture-in-miniature — reconcile's drag protection visibly holds off remote edits to
  the dragged cell). The existing `mutate()` funnel in commands.ts routes ops; local-only mode
  (autosave/world.export) stays the default and UNCHANGED when `?collab` is absent.
- **Presence:** one ephemeral entity per peer — `CursorPos {x,y}` + `PresenceInfo {name,color}`
  + a `SelectionRef { targetKey: "key" }` facet added/removed as selection changes (§15.6
  membership-as-signal). Remote cursors + selection outlines render on the overlay from
  `[CursorPos, PresenceInfo, Not(Local)]`. `leave()` wired to pagehide.
- **Durable references:** the editor's shape ids for collab mode are `doc.keyOf/resolve` at the
  persistence boundary; runtime handles stay the in-frame currency (no change to hot paths).
- **HUD:** collab chips from the two status resources via `observeResource` —
  `DurableSyncStatus` (pending/held/applied) + `EphemeralSyncStatus` (peers) + room name.
- **Verification, two layers:** (1) `?script=collab` in-process self-test — TWO worlds + two
  store pairs in one page over a loopback channel shim (the BroadcastChannel API, in-memory):
  seed on A, bootstrap B, concurrent edit + drag-vs-remote-edit, presence both ways, assert
  convergence + reactive fires, report PASS/FAIL in the HUD note (the established headless
  screenshot pattern). (2) Real two-tab manual walkthrough documented in the example README.
- **Out of scope:** WebRTC/websocket transports, persistence of the collab doc across sessions
  (localStorage of loro bytes is a stretch goal, OFF by default), text editing, and any
  framework changes beyond `exportSnapshot` (anything else discovered = report, don't patch).

## Milestones

- **D0 — transport + bootstrap + durable convergence.** The channel module, hello/snapshot
  protocol with pre-bootstrap buffering, `?collab` boot path (create LoroDoc + stores, attach,
  no autosave in collab mode), document ops through tx, drag-commit at gesture end. Two-tab
  smoke: shapes converge, drag protection observable.
- **D1 — presence + HUD + polish.** Ephemeral store + cursors/selection rendering, status chips,
  leave(), colors/names, the collab section in the example README (what to try: concurrent drag
  of one shape, delete-under-drag, undo locality).
- **D2 — the `?script=collab` self-test + headless verification** (vite build + headless Chrome
  screenshot of the PASS state + a two-cursor frame), review-lite pass (one reviewer over the
  demo diff — app code, lighter than a framework gate), README/doc pass, report.

The demo is APP code: it must read like the advertisement it is — every place the framework
absorbs complexity (no manual dirty tracking, no conflict code, no presence protocol) should be
visible by its absence, and the few places the app legitimately owns policy (transport, bootstrap,
seed-vs-join) should be small, labeled modules.
