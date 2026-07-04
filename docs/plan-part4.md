# Part IV Build Plan — The Ephemeral Layer (`strata-ecs/ephemeral`)

**Status: IMPLEMENTED** (2026-07-04; M0 a024402, M1 dab91b9, M2 a0289b3, M3 9c4dd09, review fixes 889c4f9; 626 ci + 238 stress + build green; the review gate passed with the as-built addendum recorded in 006 §C7).

**Specs this plan executes:** `design.md` §15 + the Part IV API reference (baseline, locked) as
amended by `006-part3-4-amendments.md` (normative — esp. **B5** session-unique peerId +
keepalive-own-keys-only, **C7** EphemeralSyncStatus as amended, the §A4 guard) and
`005-part2-spec.md` (§7 eid-field ban covers ephemeral; §10 as-built amendments). Where they
disagree: 006 > 005 > design.md.
**Foundation:** the Part II `Projector` (single-phase here — no relations, no baseline) and the
Part III patterns: package-level `attach*` functions, enqueue-never-apply subscriptions,
batch-atomic drains, producer-side set-on-change status resources, and the **loro API findings
block in `loro-snapshot.ts`'s header** (written for this layer's reuse).

## Locked decisions

- **`LoroEphemeralSnapshot`** (over loro-crdt's `EphemeralStore`) is the **second and LAST**
  Loro-aware class. It implements the design's `EphemeralSource` interface — per-key value blobs,
  three events (`local`/`remote`/`timeout`), `encodeChanged`/`encodePartition`/`apply` — and
  nothing else: **all projection logic lives in the store, above the interface.**
- **The LWW ordering contract is REQUIRED and must be spike-verified:** a stale out-of-order blob
  for a key must be dropped by the source, never surfaced (the blob-diff model breaks silently
  otherwise — design §15.6/E5). Verify empirically what loro's EphemeralStore guarantees; if it
  ever surfaces a stale blob, the adapter must filter.
- **Writer partitioning is absolute:** peer-prefixed keys are the partition; `eph.*` mutation of
  any entity outside your partition throws (key-prefix check), including value writes, in all
  builds. Remote entities are read-only projections.
- **`peerId` MUST be session-unique** (006 B5 — a stable per-user id + reload inside the TTL
  window makes ghosts PERMANENT via keepalive): recommend `crypto.randomUUID()` or
  `${userId}:${sessionNonce}` in docs; the **keepalive re-sends ONLY keys this session minted**,
  never own-prefix keys learned from inbound; the inbound path DEV-warns once on an own-prefix
  key this session did not mint ("peerId reuse detected").
- **Two independent outbound timers** owned by the store (no per-frame user call): the
  change-throttle (`throttleMs`, coalesce-dirty, `send(encodeChanged())`) and the keepalive
  (`~ttlMs/3`, `send(encodePartition-of-own-minted-keys)`). Explicit best-effort leave:
  `eph.leave()` deletes own keys + flushes (the app wires it to pagehide).
- **`Local` is a framework-exported tag defined in the CORE barrel** (design §15.4/§20 —
  `import { Local } from "strata-ecs"`): the store auto-tags own-partition entities at spawn;
  query-only for apps; **never transmitted in a blob** (each store applies it locally to its own
  partition — shipping it would corrupt every receiver's `Not(Local)`).
- **Blob-diff projection runs against a dedicated `lastSeenBlobByKey` cache, never runtime
  reads** (design §15.6 — the runtime carries `Local` and app-attached state a peer never sent).
  Lifecycle: `remote`+unseen → spawn + write; `remote`+seen → diff (write changed, remove
  vanished); `timeout`/delete → despawn + evict. Drains are batch-atomic (a departed peer's
  entities vanish together).
- **Structural `eph.*` inside a system throws in ALL builds** (design §15.2 / 006 §A4): the
  store reads the World's iteration state through a seam installed at attach (the facade owns
  the counter; the store never keeps its own mode). Value `eph.edit().set` on OWN entities is
  legal in-system (throttled outbound, ownership-checked); `eph.edit(remote)` always throws.
- **No relations, no resources** on ephemeral entities (design §15.6); references are `key`
  fields; the **eid-field ban** (005 §7) is validated at first replicated use, like durable.
- **`EphemeralSyncStatus`** (006 C7 as amended + Part III's as-built precedent): activity-driven
  scalars only (`peerCount` = distinct remote prefixes with live entities, `lastInboundFrame` =
  per-applied-drain counter), producer-side set-on-change, removed on detach.
- **Projection routes through the Part II Projector primitives** — stamps free (005 §5.3);
  remote cursors light up `observeQuery`/`useComponent` with zero wiring, same as durable.

## Milestones

- **M0 — spike + `LoroEphemeralSnapshot`.** Spike loro's EphemeralStore against the questions
  the design hangs on (record findings in the adapter header, extending the Part III knowledge
  block): event timing (sync vs microtask) for local set / apply / timeout; the LWW ordering
  contract under out-of-order `apply`; `encodeChanged` vs whole-store encode semantics (the
  design's `encodePartition` may need adapter-side emulation — encode only given keys);
  TTL/timeout mechanics and whether a re-`set` refreshes; what a `delete` surfaces remotely.
  Then the adapter: `EphemeralSource` implemented thinly, three events enqueue-ready, per-key
  LWW enforced (filter if loro doesn't). Acceptance: adapter contract tests incl. out-of-order
  stale-blob drop, timeout→event (short real TTLs or fake timers), partition encode, apply
  round-trip.
- **M1 — `createEphemeralStore` + the writer-partitioned Mutator.** Own-partition key minting
  (`${peerId}-${counter}`, no resume needed — ephemeral starts empty); the Mutator surface
  (spawn/despawn/add/removeComponent/edit().set/add/removeTag — no relations/resources) applying
  to the runtime IMMEDIATELY (Option A: spawn-then-edit in one input handler works) via the
  Projector + marking dirty for outbound; `Local` auto-tag (core export lands here);
  partition-ownership throws; the in-system structural throw via the attach-installed seam; the
  own-blob codec (components + tags → value blob, canonical values, `Local` excluded).
- **M2 — `attachEphemeral` + inbound projection + timers + status.** Package-level
  `attachEphemeral(world, eph): Attachment` (registers `InboundSource`; installs the iteration
  seam + Projector; double-attach throws; four-step-shaped detach: unregister → unsubscribe →
  clear queues + timers → despawn remote projections AND own entities + clear caches). Inbound:
  events enqueue; `drain()` DEV-asserts !inObserverEmit, projects batch-atomically via the
  blob-diff; `local` echoes are runtime no-ops. Outbound: both timers + `leave()` +
  keepalive-own-keys-only + the peerId-reuse DEV warning. `EphemeralSyncStatus` set-on-change.
  eid-ban at first replicated use. Reactivity assertions (remote cursor lights observeQuery).
- **M3 — the public barrel + review gate.** `strata-ecs/ephemeral` replaces the throwing
  placeholder: values `{ createEphemeralStore, attachEphemeral, EphemeralSyncStatus }`, types
  `{ EphemeralStore, Attachment }` (+ `Local` re-export decision documented); tsup entry shares
  the core chunk; dist verified (loro external, stripInternal clean); example still builds.
  Then ONE adversarial review workflow over the whole Part IV diff (probe briefs: adapter event
  semantics, partition/ghost hygiene, blob-diff contamination, timer edges, guard holes), fixes
  committed, closing doc pass (006 as-built addendum; plan status), Part IV report.

Presence is the demo pattern, not a baked-in feature: one entity in your partition, cursor
writes, `[CursorPos, Not(Local)]` renders peers. The two-tab collab demo (durable + ephemeral
together in the canvas editor) follows AFTER Part IV per James — a separate plan.

Each milestone lands green (`pnpm run ci` + `pnpm test:stress`), committed. Milestone agents on
Opus; the review gate's finders on Opus (model tiering).
