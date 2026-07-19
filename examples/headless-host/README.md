# headless-host — a Node document host for strata-ecs

The proof that **headless / server-side hosting is a first-class strata mode**. This is the "document
host" shape: a plain Node process that holds one **authoritative strata `World` + `DurableStore` per
room**, syncs with clients over WebSocket, and persists each room to disk — no DOM, no
`requestAnimationFrame`, no browser anywhere.

It is the same **bytes seam** as the browser collab demo (`examples/canvas-editor`). The canvas editor
runs a `World` in a tab and syncs peer-to-peer through a dumb relay (`examples/collab-server`). Here the
`World`s run **server-side** and the host is authoritative: it applies every client commit into its own
converged document, persists it, and relays it to the room's other clients. Same
`subscribeOutbound` / `applyRemote` / `exportSnapshot` surface; different host.

```
                 ┌───────────────── one Node process ─────────────────┐
   client A ─ws─▶ │  room "design"   World+DurableStore  ──▶ data/design.bin │
   client B ─ws─▶ │  room "physics"  World+DurableStore  ──▶ data/physics.bin│
   client C ─ws─▶ │   (N rooms = N Worlds, one shared process-global schema) │
                 └────────────────────────────────────────────────────┘
```

## Run it

Build the library first (the example consumes the **built** `dist/` via the package's exports map):

```sh
pnpm build                       # from the repo root — builds @vibecook/strata-ecs
pnpm example:headless            # start the host on ws://localhost:8788
# or, inside this dir:  node src/host.mjs
```

Then join a room with the headless client CLI (spawns two entities, edits one, prints the room, exits):

```sh
node src/client.mjs ws://localhost:8788 design
```

Env: `PORT` (default `8788`, deliberately not the canvas relay's `8787`), `DATA_DIR` (default `./data`).
Rooms are the URL path, so `ws://localhost:8788/design` and `.../physics` are two independent Worlds.

## The ops laws (stated plainly)

- **Bidirectional bootstrap.** A joiner imports the host's snapshot as its causal base, then sends its
  **own** base back. The host absorbs that base (idempotently) so the joiner's later increments — which
  reference the joiner's construction commit — don't quarantine on the host; and the host **relays that
  base to the room's other clients** so a peer that predates the joiner absorbs it too (otherwise that
  peer would quarantine the joiner's increments as missing-deps). This is the exact law
  `canvas-editor/src/collab/boot.ts` runs, re-centred on an always-present host.
- **`PendingImportError` ⇒ re-bootstrap; quarantine is permanent for a document instance.** A store that
  ever throws `PendingImportError` on import is poisoned for good — there is no in-place repair. A client
  that quarantines reconnects and re-bootstraps from scratch (a brand-new document). The host **drops**
  any socket whose bytes quarantine it. On boot it restores each room with the **reload recipe** — import
  the on-disk snapshot into a bare `LoroDoc` *before* `createDurableStore` (pristine-fast, and the only
  way a shallow / history-compacted autosave imports clean) — and if that bare import throws at all, it
  renames `data/<room>.bin` → `data/<room>.bin.quarantined-<ts>` and starts the room fresh, never bricking
  boot (the canvas-editor autosave precedent).
- **The schema is process-global.** `defineComponent`/`defineResource`/… register names in one table
  shared by every `World` in the process; a duplicate name throws. So the multi-room host imports
  `src/schema.mjs` **once** and every room's World speaks that one vocabulary. Bytes crossing the wire are
  matched by component **name**, so the host process and every client process must import the identical
  schema module. See the header of `src/schema.mjs`.
- **Tick driving is a `setInterval`.** No rAF exists server-side. The host runs a ~30 Hz timer that calls
  `world.sync()` then `world.tick(pipeline)` for every room. That is the entire non-DOM dispatch story.
- **There is no "tick driver" helper in strata's public API — on purpose.** The driver is three lines
  (`setInterval(() => { world.sync(); world.tick(pipeline); }, 33)`); wrapping it would hide the one
  decision an embedder actually makes (the cadence, and what runs in the pipeline). The host's one tick
  system (`defineTickSystem`) maintains a runtime-local `HostStats` resource (room entity count + tick
  counter) — the observable proof the scheduler is running headless.

## The wire protocol

One **binary** WebSocket frame per message: byte 0 is a 1-byte kind tag, bytes 1.. are the CRDT payload
(empty for `hello`). No JSON header, no length prefix — the frame is the length. See `src/protocol.mjs`.

| kind           | direction                                | payload                                       | meaning                                                                                      |
| -------------- | ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `hello` (1)    | client → host                            | —                                             | sent on connect                                                                              |
| `snapshot` (2) | host → client                            | `store.exportSnapshot()`                      | the host's whole converged document; the joiner imports it as its base, then is bootstrapped |
| `base` (3)     | client → host, then host → other clients | the joiner's `exportSnapshot()`               | the bidirectional law — absorbed by the host, relayed to peers                               |
| `update` (4)   | both directions                          | one sealed commit (`subscribeOutbound` bytes) | `applyRemote`'d on receipt and relayed to the room's other clients                           |

A joiner **buffers** any `base`/`update` that arrives before its `snapshot` and drains it in arrival order
once bootstrapped — an increment is never applied before its causal base is present.

## Files

- `src/schema.mjs` — the shared example schema, defined once (the process-global-schema documentation point).
- `src/protocol.mjs` — frame kinds + framing + the convergence digest (a small reimplementation of the
  canvas-editor swarm-probe oracle) + a polling await.
- `src/host.mjs` — the document host: rooms by URL path, lazy `World`+`DurableStore` per room, disk
  restore/quarantine, the bidirectional-law relay, the ~30 Hz tick driver, debounced autosave.
- `src/client.mjs` — `createHeadlessClient(url)` (programmatic) + a CLI (`node src/client.mjs ws://… room`).
- `test/smoke.test.mjs` — `node --test`: convergence, host-restart persistence, two-rooms-one-process.

## Test

```sh
pnpm build                                                    # once, from the repo root
pnpm --filter @strata-ecs/example-headless-host test          # or `pnpm smoke:headless` from the root
```
