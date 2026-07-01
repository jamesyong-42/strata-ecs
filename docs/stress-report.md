# Stress & Fuzz Report — strata Part I (Runtime Core)

Result of stress-testing the Part I runtime under adversarial load. **No correctness bug was
found.** Every core invariant held across deterministic soak scenarios and randomized property
fuzzing against an independent reference model. Two inherent serialization limitations were
identified, pinned, and documented (they are properties of the JSON snapshot format, not runtime
bugs). Three cheap DEV-mode guards were added to turn latent footguns into loud failures.

Run it: `pnpm test:stress` (heavy; gated out of the fast `pnpm run ci`). Scale with
`STRESS_SCALE=N` (default 1) — e.g. `STRESS_SCALE=10 pnpm test:stress` for a longer soak.

## What was exercised

### Deterministic scenarios (`src/core/__stress__/*.stress.ts`)
| Scenario | Probes | Result |
|---|---|---|
| Generation-wrap ABA | 2^12 generation ceiling (`entity-table.free`) | Pinned — collides at exactly the 4096th recycle, as designed |
| MAX_SLOTS exhaustion | 2^20 slot ceiling (`entity-table.grow`/ctor) | Clean throw at slot 1,048,577; exactly 2^20 succeed |
| Archetype explosion | dedup + cached-query correctness across 4,095 signatures | All query match-sets exact; one archetype per signature |
| String-column leak hunt | null-capacity invariant after every add/write/remove/destroy | Every cell ≥ count stayed `null` throughout |
| Archetype ping-pong | back-pointer symmetry + value preservation across A↔B churn | Values preserved over 20 rounds × 500 entities |
| Relation fan-out + cascade | reverse-index symmetry; O(fan-out) despawn (5k/3k edges) | Symmetric; cascade unlinks all; reused slot stays clean |
| Deep command buffer | single-pass flush, pool reuse, ordering hazards | All deferred ops applied; no leak; policies held |
| Large snapshot round-trip | export→import fidelity (3k entities, refs/relations/tags/resources) | Model-identical |

### Property-based fuzz (`src/core/__stress__/*.fuzz.ts`, fast-check, seeded)
- **Random op sequence vs reference model** — spawn/destroy/add/remove/write/tag/relation applied to
  both the real world and a plain-JS oracle; full state compared after *every* op. The oracle
  replicates entity-table semantics (bump-on-free, wrap-skip-0, LIFO free-list), component values,
  tags, and bidirectional relations (incl. validate-on-read). **No divergence.**
- **Query vs brute-force predicate** — random world × random query (required/excluded/`Any`/tag/
  relation, concrete-target *and* abstract); engine result set == naive filter, for both the dense
  and reverse-index-seeded dispatch. **Exact match.**
- **Snapshot round-trip** — random world serialized and reloaded; uid-keyed canonical model
  identical. **Exact match.**

## Invariants verified (never broke)
1. **Generation validity** — a stale/double-freed handle always reads not-alive (until the pinned
   2^12 wrap).
2. **String-null capacity** — every string cell at/above `count` is exactly `null` (no `undefined`
   holes, no leaked strings) across swap-pop, migrate, grow, destroy.
3. **Placement / back-pointer symmetry** — each placed entity appears once; its slot points back to
   its archetype row; carried values survive migration.
4. **Relation bidirectional symmetry** — every forward edge has a reverse edge; despawn clears both
   directions; a reused slot never inherits dead edges.
5. **Archetype dedup + query-match-cache correctness** — one archetype per signature; cached match
   lists stay exact as archetypes appear.
6. **Single-pass flush stability** — the drain applies each command once, resets, and the buffer
   pool does not leak across ticks; validate-on-read and dev-error-skip policies hold.
7. **Snapshot round-trip fidelity** — component sets/values, tags, one/many relations, eid refs, and
   resources reproduce up to identity relabeling; dangling/out-of-snapshot refs collapse to null.

## Hard limits (pinned, with failure mode)
| Limit | Value | At/over the limit |
|---|---|---|
| Slot index | 2^20 = 1,048,576 live entities | **Clean throw** (`grow`/constructor) |
| Generation | 2^12 = 4,095 per slot | **Silent ABA wrap** — defined but lossy (§2); DEV notice added |
| Command buffer | unbounded | No cap → OOM under runaway deferral; DEV soft-cap warning added |
| Snapshot | one JSON string (~V8 max ~2^29 chars) | Clean `RangeError` at extreme scale (not triggered in-suite) |
| Enum discriminant | u8/u16/u32 auto-routed; `[0, 2^32)` | Clean throw at schema-define time |

## Findings — inherent serialization limitations (pinned, not bugs)
These are properties of the **JSON snapshot format** (§8), not the runtime. Documented and pinned so
a future format change (e.g. a binary snapshot) surfaces as an intentional behavior change.

1. **`-0`, `NaN`, `Infinity` are not preserved.** `JSON.stringify` turns `-0` into `"0"` and
   `NaN`/`Infinity` into `"null"`; import decodes these back to `+0`. Pinned in
   `snapshot.stress.ts`. Numerically `-0 === +0`, so this is immaterial for editor/collab data; the
   `NaN`/`Infinity` → `0` case is the one to be aware of.
2. **Lone UTF-16 surrogates in string fields are lost.** Export encodes the JSON via UTF-8
   (`TextEncoder`), which replaces unpaired surrogates with U+FFFD. Well-formed strings (including
   full emoji / astral characters) round-trip exactly. Only lone surrogate halves are affected.

## Guards added (all DEV-only; stripped in production)
- **`pack()` range assert** (`entity.ts`) — throws on a slot ≥ 2^20 or generation > 4095 instead of
  silently aliasing a different handle.
- **Generation-wrap notice** (`entity-table.free`) — warns at each wrap, surfacing the exact moment
  ABA risk begins on a slot.
- **Command-buffer soft cap** (`runtime-store.enqueue`) — one-shot back-pressure warning when a
  single phase's buffer crosses a threshold (default 1,000,000 ops); never throws mid-flush.

## Recommendations deferred (candidates for later parts)
Scope was **pin + cheap guards**; these are larger changes intentionally left for later:
- **53-bit generation fallback** to close the ABA window (the deferred "full hardening" option).
  Today's 2^12 wrap is a documented, accepted tradeoff.
- **Streaming / binary snapshot** to lift the single-JSON-string ceiling and fix the `-0`/`NaN`/
  surrogate fidelity gaps in one move.
- **Relation-edge back-pressure / batched `clearEntity`** — despawning a very-high-degree node is
  O(degree) and can stall a frame; worth revisiting if editor workloads create such hubs.
- **`observeArchetypes` cost** is O(Q) per new archetype and query registration is O(A); fine at
  the scales tested (4k archetypes), but note it if archetype counts grow much larger.
