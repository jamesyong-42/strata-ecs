# Patch Note 004 — Parts II–IV Revision Plan

**Baseline:** `design.md` (locked) Parts II–IV, adjudicated against `design-comments.md` and the
as-built Part I (which now includes T0 observability, 001 access declaration, 002 reactivity, 003
resource reactivity + strata/react — none of which existed when Parts II–IV were specced).

**Method:** 4 design dimensions (comments-correctness, comments-domain, reactivity×II–IV,
substrate-fit), each red-teamed by an independent skeptic; every amendment below is
post-red-team. Priorities: **must** = normative before Part II code; **should** = spec now,
implement when the layer lands; **could** = fast-follow.

**The headline discovery (reactivity×II–IV):** Part I quietly overbuilt into Part II. Every
primitive §10.3's projector kernel needs already exists with the exact semantics the spec asks for —
`allocateIdentity`, `ensurePlaced`, `projectComponent` (add-if-absent-else-write, stamped in all
three branches), `projectRemoveComponent`, the both-directions destroy cascade, `world.sync()` +
`InboundSource` — and **all of them already carry the 002/003 stamps behind the reactiveOn gate**.
Remote edits, own-echoes, attach, and undo will light up `observeQuery`/`useComponent` with zero new
machinery. Part II is therefore small: types, the baseline, the Projector class, two runtime
additions, and a conformance suite. The revision work is mostly making implicit truths normative.

---

## A. design-comments.md adjudication

All four correctness issues are **REAL**, verified against both spec text and shipped code. Of the
domain gaps: one deliberate scope cut, two must-specify. One smaller note was refuted ("key" field
type already shipped in ff6d1ea).

### A1 (must) — Canonical values + cell equality → new §9.5; revises §12.2/§12.3/§13.1/§13.3

Issue 1 confirmed as the worst bug: the runtime canonicalizes through typed arrays (f32 fround,
integer coercion, enum discriminants) while §12.3's seal writes **raw literals** into the baseline —
so `runtime == baseline` diverges permanently from attach onward for any non-f32-exact value, and
every remote value to that cell is dropped as "mid-drag" forever.

- `canon(C, v) = decode(C, encode(C, v))` — the value as it reads back through the component's
  columns. **Every** value entering the document or baseline is canonical: tx records canonical,
  attach seeds canonical, reconcile canonicalizes before compare/write.
- `cellEquals(a, b)`: both-undefined equal; per-field `scalarEquals(x,y) = (x===y) || (x!==x && y!==y)`
  — NaN==NaN (survives f32 round-trip; `===` would strand it), +0==−0 (Object.is would strand −0).
- Replace every `runtime(cell) == baseline(cell)` in §13.3/§13.4 with `cellEquals(...)`.
- **Red-team amendment (normative):** `canon` is total over well-formed values, *partial* over
  inbound ones — reconcile MUST NOT throw on an un-canonicalizable inbound value. Fields with
  declared defaults are filled; any other malformation **rejects that single fact** (dev-warn naming
  key/component/field), touching neither runtime nor baseline — which provably cannot strand the
  cell (`runtime == baseline` still holds; the next valid fact reconciles normally). `eid`
  canonicalizes as `u32 >>> 0`; durable components should use `key` fields, not `eid` (see A5/C5).
- Conformance property: `canon` idempotent; after any commit/attach, `cellEquals(runtime, baseline)`
  for every non-diverged cell.

### A2 (must) — CRDT layout contract: assignment unit = conflict unit → §9.3 + normative box in §14.2

Issue 2 confirmed: no Loro layout is specified anywhere, and §13.4's committer-wins-per-component
silently requires one-component-one-atomic-register (a nested per-field LoroMap would field-merge
"your x with their y").

- **Component value / resource value = one atomic register** — a plain value assigned wholesale,
  never decomposed into per-field container keys. FORBIDDEN sentence scoped exactly to values.
- **Red-team amendment:** tags and relation edges are the opposite — **per-entry keys** (e.g.
  `tag:Name → true`), NOT one tags-blob register: a single blob would LWW-clobber concurrent adds of
  *different* tags. Arity-one relation = one register; each many-edge = its own key.
- Conformance: concurrent different-field commits converge to one committer's whole component on all
  peers; concurrent different-tag adds converge with BOTH tags present.

### A3 (must) — Write-side gesture safety → §17, §18.3; optional `trySet`

Issue 3 confirmed and **worse than the comment stated**: §17's own mitigation claim ("ctx.edit
harmlessly no-ops via validate-on-read") is FALSE against shipped code — `writeComponent` throws on
dead handles AND absent components; validate-on-read exists only for buffered StructuralCommands at
flush. The §18 example crashes in two places the frame a collaborator despawns the drag target or
removes its Position.

- Correct §17's false claim. New normative rule with the red-team's corrected justification:
  **re-validation must occur in the SAME system run that writes** (immediately before the write) —
  within one system body nothing structural can interleave (remote lands at sync, buffered commands
  at phase flush), but presence is NOT stable across phase boundaries, so a top-of-frame check does
  not license writes in later phases.
- Fix §18.3: pointerup uses `ctx.get` + cancel-on-undefined; DragSystem guards presence and destroys
  the gesture when the target/component is gone.
- Could-level: `EntityEditor.trySet(C, v): boolean`.

### A4 (must, red-team: sound) — Mid-tick guard on the World facade → Part I addendum; rewrites §15.2's parenthetical

Issue 4 confirmed: §15.2 asserts an `isIterating` guard that exists nowhere, and Part I's ECSStore
section forbids a store-side mode. Resolution keeps both texts true:

- Runtime hosts an `iterationDepth` counter, inc/dec (try/finally) around every query dispatch.
- **World's** structural methods throw in ALL builds when `> 0` (mid-iteration migration is memory
  corruption, not style); value writes stay exempt. The store never consults it (storage-ownership ≠
  semantics-ownership — the buffer-pool precedent). EphemeralStore reads the same counter — this is
  the mechanism §15.2 already promises.
- Bench before landing (the reactiveOn lesson), though cost is per-structural-op, not per-write.

### A5 — Smaller notes (all accepted; one refuted)

- **(should, sound)** Baseline memory honesty paragraph: a full second in-memory copy (third with
  Loro), single-digit MB at editor scale, deliberately NOT lazily materializable (reconcile needs
  per-cell reads at any moment; a Loro-backed view would destroy the lagging-anchor semantics).
- **(should, sound)** Inbound-burst amortization: v1 accepts the one-frame hitch and says so; the
  sanctioned future mechanism is time-budgeted **batch-granular** draining — never split one
  ChangeBatch (batch atomicity is per-commit). Late join: import bytes BEFORE attach.
- **(should, sound)** `undo()`/`redo()` are **local-ops-only** (Loro UndoManager, never checkout/
  time-travel — the classic collaborative-undo bug foreclosed in one sentence).
- **(should, amended)** Delete §17's tombstone/GC language (defined nowhere; as-built despawn is
  eager both-directions inline). Enumerate BOTH residual dangling surfaces: `eid` fields (validated
  at readEid) and `key` fields (validated at resolve time).
- **(could, sound)** Normative drain order: attachment order, deterministic, each source to
  completion; durable-before-ephemeral guidance; mid-frame attach drains next sync.
- **REFUTED:** "add a `key` field type" — it already shipped (field.ts:12–38, branded EntityKey +
  `entityKey()`, commit ff6d1ea). Doc-only residue: §18.1's `Selection.targetKey` should say
  `"key"`; cite the type in §15.6; soften §14.3's hedge.

## B. Domain gaps (issues 5–7)

### B1 (must) — Ordered relations: CUT from v1; fractional-index order-key is THE pattern → §3.3, §4, new §14.4, §18.1

As built, `defineRelation`'s `ordered` flag is **dead** — schema.ts stores it, relations.ts never
reads it (unordered Sets). The signature promises something the runtime doesn't do.

- Remove `ordered` from the signature + the Relation handle + the pass-through test + design.md's
  hierarchy-index promise (§3.3 line 255).
- New §14.4 "Ordering under collaboration": order is a **value** — a single-field component
  (`Order { key: "string" }`) holding a fractional-index string, merging whole-component
  committer-wins like everything else. Zero new doc-facts, zero runtime index, adapter untouched.
  Readers sort siblings at read time (cacheable via the per-archetype stamps) with a **deterministic
  EntityKey tie-break** so equal keys converge identically on every peer.
- Export two pure helpers: `orderKeyBetween(a, b, rng?)` (red-team: deterministic midpoint by
  default, jitter only via injected RNG — §17 determinism) and `compareOrderKeys`.
- §18.1's `ZIndex { z: "i32" }` example switches to the order-key form.
- Explicitly deferred with named forward path: LoroTree fractional index if subtree-move semantics
  are ever demanded. MovableList rejected — dual membership truth (list + map) is a real hazard.

### B2 (must, sound) — Text merge granularity, stated LOUDLY → §13.4, §18.1, §4 box

Normative: a `string` field participates in whole-component committer-wins; concurrent text edits do
NOT merge keystrokes — the later committer's whole string wins. Rules: text lives in single-field
components (`Label`); commit at coarse boundaries (blur/idle — SHOULD-strength).

**(should, amended)** Forward-path note (non-normative, new §13.6): a `"text"` field type — runtime
stays a `(string|null)[]` column; one LoroText container carved out per text field inside the
component entry (the layout carve-out reserved NOW so text is never a breaking format change).
**Critical red-team fix:** the adapter must NOT use `LoroText.update(newString)` (it diffs against
the *current* doc and would delete concurrent remote characters — committer-wins with extra steps);
it must compute the delta against the **baseline** text (the last agreed value §13.2 already
maintains) and apply positional insert/deletes — that is what actually merges keystrokes.

### B3 (must, amended) — Foreign schema on the wire → new §13.7

- R1: the adapter surfaces ChangeEvents only for names resolvable in the local schema; unknown names
  → no event, not projected, entity's known components project normally.
- R2: outbound writes are per-component-name, never wholesale container rewrites — so unknown
  components survive every local edit and echo **structurally**, not as a special case.
- R3: despawn deletes the whole container (entity-level intent). Amendment: unknown-relation edges
  targeting the despawned key from elsewhere remain as dangling facts for peers that know them.
- R4: unknown FIELDS in a known component — projection writes known fields; local commit overlays
  known-field values onto the converged raw value (never strips a newer peer's `Position.z`).
  Amendment: the surfaced ChangeEvent value is the local-schema projection (stripped); the baseline
  stores the stripped value; all compares are over local-schema fields only.
- R5: dev-mode one-shot log per unknown name. No version negotiation in v1 — name-keyed storage plus
  R1–R4 IS the mixed-version story.

### B4 (must, amended) — Inbound validation: canonical-encode, reject-don't-clamp → rides A1's §9.5

- Malformed (wrong JS type, non-finite, missing no-default field, unknown enum discriminant) →
  REJECT the fact; neither side of the compare moves → provably no strand. Per-cell quarantine
  counter + dev warn (mirrors §13.5).
- Representable-but-out-of-range → identical to a local write: **modular wrap** for integer columns
  (300 into u8 = 44 — ToUint8, not truncation/clamping; red-team precision fix), fround for f32.
  Inbound and local writes MUST canonicalize identically; no separate clamping policy exists.
- Amendment (schema evolution, cross-ref §17): adding a required no-default field to a live durable
  component is a **wire-breaking change** (older peers' writes reject on newer peers); new fields on
  live components MUST carry defaults.

### B5 (must, amended) — Ephemeral peerId is session-unique → §15.2/§15.3/§18.4

Red-team found it **worse than the original comment**: with a stable peerId, the ghost keys of a
crashed session arrive inbound under your own prefix, and the keepalive re-sends the *whole
partition* (`encodePartition(myPrefix)`) — so the new session refreshes the ghosts' TTLs **forever**;
they never expire.

- Normative: peerId MUST be session-unique (`crypto.randomUUID()` or `${userId}:${sessionNonce}`);
  display identity lives in components, never the key prefix.
- Normative (the real fix): the keepalive re-sends **only keys this session minted**, never
  own-prefix keys learned from inbound.
- Dev warning on the **inbound** path: a remote event delivering an own-prefix key this session
  didn't mint = "peerId reuse detected".

### B6 (should, sound) — v1 scope table → new §21

IN: foreign-schema preservation (B3), inbound validation (B4) — both retrofit-hostile (first
cross-version echo after two builds diverge is data loss); order-key pattern + helpers; session-
unique peer ids; the diagnostics. DEFERRED with named forward paths: ordered index/LoroTree; text
CRDT (B2's §13.6); version negotiation; burst amortization; `ctx.ephemeral`.

## C. Reactivity × Parts II–IV (the 002/003 dividend)

### C1 (must, sound) — Projection lands through the stamped primitives; collaborative reactivity is FREE → §10.3, §13.1, §13.3; amends 002 §0/§6

Verified as-built: every kernel primitive already stamps (projectComponent in all three branches
incl. migrate carry-forward; place/unplace bump lastStructuralFrame; tag/rel ops bump tagRelFrame;
destroy at :656; setResource at :924). Make it a MUST: projection MUST route through the stamped
primitives; raw-column projection is forbidden (a future bulk-attach fast path may exist only if it
stamps equivalently). Consequence stated as a guarantee: remote edits/echoes/attach/undo are visible
to `world.reactive` and `strata/react` with no additional feed. Amend 002's "local-runtime only /
remote feeds deferred" language — obsoleted by construction. Attaching a store does NOT flip
`reactiveOn` (a collaborative world with no observers pays zero stamp stores).

### C2 (must, amended) — One settled boundary per frame → new §16.4

`sync() → tick(s) → notify() (exactly once) → render`. Stamps written during drain carry the current
frame; one notify observes them — remote-edit-to-observer latency is zero frames. Rules:
- Reconcile/drain MUST NOT run inside notify(). **Red-team correction:** the per-primitive
  observer-emit guards deliberately do NOT cover the projection primitives (projectComponent/
  ensurePlaced are unguarded because they must run mid-drain) — so a mid-notify drain would
  **half-apply a batch** (adds land, removes silently swallowed), violating batch atomicity in the
  worst way. Therefore: `drain()` DEV-asserts `!inObserverEmit` at entry (one check per drain), and
  `world.sync()` throws mid-tick (rides A4's iteration guard).
- Extend the setResource-in-emit devWarn to `writeComponent`.
- Batch atomicity + poll-at-boundary compose: observers can never see a half-applied ChangeBatch; no
  "suppress observers during drain" mechanism exists or is needed.

### C3 (must, sound) — Attach fires observers once: the first-paint rule → §13.1

Attach MUST NOT suppress stamps, and it is not a storm: the poll model coalesces to at most one fire
per observer at the next notify ("the document arrived — paint"). Registration timing stated
exactly: pre-attach observers see the attach at next notify; post-attach registrations do NOT
retro-fire (baseline at frame−1) — they read current state through the snapshot path (a React
component mounted after attach renders the projected value immediately). Detach needs no special
rule: teardown routes through destroy() → death hooks fire undefined, Tier-1 fires as membership
empties. Say all of this; users will otherwise expect emitter-style retro-fire.

### C4 (must, sound) — 001 enforcement × projector/executor → §10.3, §12.3; amends 001 §2.2

Projection is exempt **by construction** (runs with `currentSystem === null`; chokepoints are
no-ops), and MUST NOT acquire an access envelope. The one crossing: a `doc.transaction` inside a
system applies pre-existing-component value writes synchronously through `writeComponent` → the
enforcement chokepoint fires with `currentSystem` set. Normative: such a system MUST declare those
components in `access.write` (correct, not incidental — the write is same-phase-visible and must be
stamp-attributed like any system write). **Fix design.md §12's CommitOnSettle example** — as written
it throws in dev once any observer arms enforcement.

### C5 (should, amended) — Held-cell ledger replaces the pure drop → §13.3, §13.5

Real gap: a drag that reconverges to baseline WITHOUT committing strands the dropped remote value
forever (no future fact re-delivers it; the stranded-cell warning never fires because drops stop).
Ledger: latest held value per cell; sweep at end of every drain applies where agreement returned.
**Red-team supersession rules (mandatory — the naive sweep resurrects conflict-losing values):** a
held entry is cleared by (a) any applied value fact for the cell, own-echo or remote; (b) the local
commit's synchronous agreement (the held value lost committer-wins); (c) any structural fact on the
cell (else the sweep's add-if-absent resurrects a removed component). The sweep applies ONLY on the
exact silent-reconverge case. Holds never stamp/notify (runtime didn't change); applies stamp at the
frame of application. Sweep runs on every drain including empty ones. v1-simpler alternative if cut:
keep pure drop + one loud staleness paragraph — but the ledger is ~30 lines and feeds the sync tab.

### C6 (should, amended) — T0 lifecycle origin → observe.ts contract widening

`onSpawn`/`onDestroy` gain an origin argument (backward-compatible extra param, constructed only
inside the `observerList !== null` branch). **Red-team correction:** a flat "projection" value lies
for destroys — your own `tx.destroy` reaches the runtime via projection during the own-echo, so it
would report as a collaborator's action. Either thread the reconcile batch's `Origin` through the
projector (origins: `local | remote | attach | import`) or document honestly that origin reports the
*path*, not the author. Drop the destroy-side `import` value (unreachable).

### C7 (should, amended) — SyncStatus resources riding 003 → new §15.7 + §12.4 paragraph

Binding-maintained runtime-local resources (`DurableSyncStatus { pendingInbound, heldCells, … }`,
`EphemeralSyncStatus { peerCount, lastInboundFrame, … }`) — a React sync panel becomes
`useResource(world, DurableSyncStatus)` with zero new observer machinery. **Red-team corrections:**
(1) fields must be activity-driven — a `lastDrainFrame` bumped every drain would re-render every
frame forever on an idle network (sync() drains unconditionally per frame); use `lastAppliedFrame`
(bumped only when ≥1 fact applied). (2) Producer-side set-on-change is mandatory: the binding
compares against the last-set value and skips `setResource` when equal. Peer LIST stays a query
(`[PresenceInfo, Not(Local)]`), never a resource. Connection state stays app-owned (the binding
never sees the transport) — bless the app-defined ConnectionState-resource pattern.

### C8 (could, sound) — strata/tools sync tab + SyncObserver → tools section

`binding.observeSync(obs)` under exactly the T0 contract (branch-on-null, read-only, must-not-throw,
fires mid-drain so callbacks must not mutate): onEnqueue/onDrainStart/onFactApplied/onHold/
onHeldApplied/onDrainEnd. Spec only the interface shape as normative (emit sites are cheap to build
in, expensive to retrofit); the tools tab is fast-follow.

## D. Substrate drift fixes (Part II spec vs as-built Part I)

- **D1 (must, amended)** Retype the ladder + doc-facts on **schema objects** (Component/Tag/
  Relation/Resource), not numeric ids — the entire as-built currency is objects; §10.3's sketch
  wouldn't compile against `projectComponent<S>`. Persistent members store `.name`, resolve via
  `componentByName` at the adapter boundary. Amendment: only local snapshot/baseline reads throw on
  unknown names; for `applyRemote` unknown-name handling is B3's policy — Part II only requires
  detection, never silent misbinding.
- **D2 (must, sound)** ONE EntityKey: Part II imports the shipped brand (field.ts unique-symbol +
  `entityKey()`), deleting the API reference's incompatible second brand.
- **D3 (must, sound)** Cut `Snapshot<K>` genericity and `StorageKey`: the ladder is EntityKey-only;
  the local snapshot is formally exempt (as built it is two standalone functions, not a ladder
  member — the K=number instantiation had zero implementors).
- **D4 (must, amended)** Add `RuntimeStore.removeResource` (the `resource-remove` doc-fact is
  otherwise a reconcile dead-end): stamps via bumpResource; mirrors setResource's in-emit devWarn;
  **absent-remove is a stampless no-op** (idempotent projection); expose on World/ECSStore for
  symmetry.
- **D5 (must, amended)** ComponentValue wire form: decoded, name-keyed, enum labels. A component
  replicated by the durable **or ephemeral** layer MUST NOT contain `eid` fields — use `key` fields;
  both attaches validate at registration (DEV throw). Kills the remap-handles-at-boundary problem
  class outright.
- **D6 (should, amended)** Rewrite §10.3 against the as-built primitives (they all exist; freeze the
  signatures). Document the onSpawn-at-identity semantics for projected entities (fires identity-
  only, matching ctx.spawn). **Correction:** in-emit guard behavior is MIXED across primitives by
  design — the reliable guard is C2's drain-entry assert, not per-primitive checks.
- **D7 (should, amended)** Interface honesty: arity-split reads (`getRelationOne`/`getRelationMany` —
  writes already split); EntityRecord specced as the as-built §8 record shape; add
  `World.unregisterInboundSource` (the shipped name is `registerInboundSource` — the spec must not
  cite a method that doesn't exist) and prepend it as teardown step 0.

## E. Part II build plan (M0–M4; Loro deferred to Part III)

- **M0 — spec revision first.** Land this note's musts as design.md/002 edits (or as this note's
  normative sections referenced from a design.md amendments header): A1–A4, B1–B5, C1–C4, D1–D5.
- **M1 — pure types + one pure function.** Snapshot/MutableSnapshot/CRDTSnapshot, ChangeBatch/
  ChangeEvent/Origin (schema-object currency), and `normalizeBatch(events)` as an exported pure
  function with table-driven tests. **Red-team contract:** (a) cell taxonomy — entity existence is
  itself a cell per key; each (key,component), (key,tag), (key,rel,target|all), (res) is a cell;
  (b) dominance — despawn(k) erases all earlier facts for k; spawn(k) after despawn(k) starts a
  fresh record; (c) surviving facts preserve relative order. Acceptance oracle: P5 below.
- **M2 — the baseline.** In-memory MutableSnapshot: nested Maps keyed by EntityKey, a reverse
  relation index satisfying the three-part despawn contract, name-keyed cells, canonical values
  (A1) enforced at every write.
- **M3 — the Projector + runtime additions.** The kernel class over the existing primitives
  (bijection, resolveByKey/createPair/requireKey, cell-apply, teardown); `removeResource` (D4);
  `unregisterInboundSource` (D7); the sync-in-emit + mid-tick guards (C2/A4). Bench gate: the
  iteration-counter and any new DEV checks ride the existing suite.
- **M4 — conformance suite, gating Part III.** Shared op interpreter: random ops applied to the
  store under test through the ladder AND to a RuntimeStore oracle via a key↔handle map. Properties:
  P1 ladder-runtime cell equivalence; P2 despawn completeness (no incoming edge survives anywhere);
  P3 projector bijection under random interleavings (requireKey throws exactly for unbound); P4
  export→import identity up to handle renaming (incl. dangling eids); P5 normalizeBatch ≡ raw apply;
  P6 every projector apply visible to observers at next notify (extends stamps.test.ts to the
  projection path); P7 projection idempotence. Written generically so LoroSnapshot runs the
  identical suite on day one of Part III.
- **Scope cut:** no loro-crdt dependency in Part II. LoroSnapshot is Part III M0, written against
  the frozen CRDTSnapshot interface + M4 suite.

---

*Sources: multi-agent design run wf_82519e6e-f40 (Track B: 4 analysts + 4 red-team skeptics; 34
proposals — 13 sound, 21 amended, 0 flawed). Companion: `review-part1.md` (Part I honest review).*
