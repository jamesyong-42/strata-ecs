# Part III Build Plan — The Durable Layer (`strata-ecs/durable`)

**Specs this plan executes:** `design.md` §11–§14 (baseline, locked) as amended by
`006-part3-4-amendments.md` (normative) and `005-part2-spec.md` (the frozen Part II contract,
including its §10 as-built amendments). Where those disagree, 006 > 005 > design.md.
**Foundation:** Part II as shipped — the `CRDTSnapshot` interface (frozen), `BaselineSnapshot`,
`normalizeBatch`, `canon`/`cellEquals`/`tryCanon`/`tryCanonResource`, the `Projector`, and the
M4 conformance suite (`runConformance` is the Loro adapter's acceptance gate, built before it).

## Locked decisions

- **Dependency shape mirrors `strata-ecs/react`:** `loro-crdt` (latest stable) is an **optional
  peerDependency** + devDependency for tests. Only two classes in the whole codebase may import
  it: `LoroSnapshot` (this part) and `LoroEphemeralSnapshot` (Part IV). Everything else speaks
  Part II interfaces.
- **Code lives in `src/durable/`** (auto-included in the root typecheck like `src/substrate/`).
  The `strata-ecs/durable` subpath keeps its loud placeholder until M5 wires the real barrel —
  a half-shipped surface must keep throwing, not partially work.
- **Document layout** (005 §3, concretized): root `LoroMap "entities"` → per-entity `LoroMap`
  with keys `exists: true`, `comp:<ComponentName>` → **plain value object assigned wholesale**
  (one atomic register — never a nested container), `tag:<TagName>` → `true` (per-entry),
  `rel:<RelationName>` → targetKey (arity one, one register), `rel:<RelationName>/<targetKey>`
  → `true` (arity many, per-edge). Root `LoroMap "resources"` → `<ResourceName>` → atomic value.
  **Names, never run-local ids** (005 §1.2). Values stored canonical (005 §2; resources via
  `canonResource` — 005 §10.1).
- **Unknown names** (006 B3 R1): the adapter surfaces no ChangeEvent for a name it cannot
  resolve — skip + one-shot DEV diagnostic per name; never misbind, never destroy on echo
  (outbound writes are per-component-name, R2, so preservation is structural).
- **Keys:** the shipped `EntityKey` brand; peer-prefixed `${peerIdStr}-${counter}` minted by the
  store, counter **resumes past max existing suffix** for this peer (design.md §14.2).
- **Undo/redo:** Loro `UndoManager`, local-ops-only (005 §1.3) — never checkout/time-travel.
- **eid-field ban:** attach validates every registered durable component has no `eid` fields
  (005 §7) and DEV-throws; references use `key` fields.

## Milestones

- **M0 — `LoroSnapshot`** (the first of the two Loro-aware adapters). Implements the frozen
  `CRDTSnapshot` over a user-owned `LoroDoc`: the layout above; `commit(body)` as a scope sealing
  ONE Loro commit; `subscribe` delivering **one origin-tagged `ChangeBatch` per commit** (local
  echo AND remote); `applyRemote(bytes)` → import → `ChangeBatch[]` in commit order; `export()`;
  `undo()`/`redo()` via UndoManager. Adapter-internal: Loro event diff → `ChangeEvent`
  translation with name→schema-object resolution at the read boundary.
  **Acceptance:** `runConformance(() => new LoroSnapshot(new LoroDoc()))` — the identical P-suite
  the baseline passes — plus adapter-specific properties: the 005 §3.4 convergence pair
  (concurrent different-field commits → exactly one committer's whole component on both peers;
  concurrent different-tag adds → both present), batch-per-commit boundaries (multi-commit
  buffers → multiple batches, order preserved; mixed-origin unrepresentable), undo-is-local-only,
  export→applyRemote round-trip.
- **M1 — `createDurableStore(doc)` + key minting.** The `DurableStore` shell: `docId`, `keyOf`/
  `resolve`, converged reads (`getComponent`), `applyRemote` (fire-and-forget wire entry →
  binding queue), `subscribeOutbound` (sealed-commit bytes), counter-resume minting. No
  transaction yet.
- **M2 — the binding: attach / detach / drain.** `world.attachDurable(store)` → two-phase
  projection (entities/components/tags then relations) seeding the **baseline** (canon values;
  the founding agreement), `registerInboundSource`; Loro subscription **enqueues only** (never
  applies); `drain()` DEV-asserts `!inObserverEmit` at entry (005 §5.5/§10.6) and reconciles.
  Detach = the four-step teardown (unregister → unsubscribe → clear queue → despawn+unbind).
  Attach invariants: no double attach; re-attach mints fresh handles; durable entities enter
  only via attach/inbound.
- **M3 — the transaction: recorder + executor.** `doc.transaction(fn)` with the `tx` Mutator:
  overlay preconditions (pre-existing vs introduced-this-tx; value writes FOLD into structural
  payloads); eager identity + `createPair` at record time; seal = ONE sealed Loro commit
  (spawns → cells/tags/relations → despawns); **values to pre-existing components apply
  runtime+doc+baseline synchronously — canonical** (006 A1); structure reaches the runtime only
  via projection; throw-rollback (gen-bump minted identities, burn keys); in-system commits ride
  the 001 enforcement rule (006 C4: declare `access.write` for tx value writes).
- **M4 — reconcile.** Per drained `ChangeBatch`: `normalizeBatch` → classify against the
  **pre-commit** baseline (entity existence first; `component-set` disambiguated
  absent→structural / present→value) → the origin×kind matrix with **`cellEquals` everywhere**
  (canon on both sides), `tryCanon`/`tryCanonResource` inbound gates (reject → touch neither
  side), structural applies via the Projector, value applies drag-protected; own-echo skip
  advances baseline, remote drop touches nothing; the **held-cell ledger** with 006 C5's
  supersession rules (cleared by any applied fact / local commit agreement / structural fact;
  sweep applies only the silent-reconverge case); stranded-cell DEV counter (§13.5); foreign
  schema R1–R5. Batch atomicity: one batch applies to completion, no user code between facts.
  **Acceptance:** the full origin×kind matrix as table-driven tests + a two-store convergence
  harness (two worlds, two docs, byte exchange) covering the §18.5 drag flow: local drag
  divergence drops remote values, commit wins as later op, both sides converge; reactivity
  lights up via 005 §5.3 (observeQuery sees remote edits with zero wiring — assert it).
- **M5 — surface + status.** Wire the real `strata-ecs/durable` barrel (replace the throwing
  placeholder), `DurableSyncStatus` resource (006 C7 as amended: activity-driven fields only,
  producer-side set-on-change), the §13.5 stranded-cell warning text, docs. Example upgrade
  (two-tab BroadcastChannel collab demo) is a **separate decision** — not in this plan.

Each milestone lands green (`pnpm run ci` + `pnpm test:stress`), committed; adversarial review
workflow after M0 (the adapter is the correctness keystone) and again after M4 (the reconcile
matrix), fixes committed before the next milestone starts.
