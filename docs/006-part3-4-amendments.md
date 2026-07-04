# Patch Note 006 — Parts III–IV Normative Amendments

**Status:** Proposed — the ready-to-apply normative amendment text for `design.md` Parts III–IV (plus two Part I addenda), executing milestone **M0** of `004-part2-4-revision.md` for everything **not** Part II-scoped.
**Scope:** Part III (durable), Part IV (ephemeral), Part V (cross-cutting + worked example). Two Part I addenda ride along: the **mid-tick guard** (A4) and the **projection-visibility amendment to 002** (C1).
**Baseline:** `design.md` (locked) + patch notes 001–003 (the as-built Part I). This note is an *amendment*; §N references point into the locked doc, and it does not modify it.
**Depends on:** `004-part2-4-revision.md` — the settled revision plan. Every amendment below is **post-red-team and not relitigated**; this note only expands each into normative text precise enough to apply mechanically. Also depends on 001–003 as built.
**Companion:** `005-part2-spec.md` covers Part II — **A1** (canonical values / `cellEquals`), **A2** (the one-component-one-atomic-register CRDT layout contract), **D1–D7**, and the **M0–M4** build plan. This note cross-references **005** where a Part III/IV rule rides a Part II mechanism, and does **not** duplicate that content.

---

## 0. What this note does

004's headline discovery is that Part I already overbuilt into the collaborative layers: every projector primitive stamps behind the `reactiveOn` gate, so remote edits, own-echoes, attach, and undo already light up `world.reactive`/`strata-ecs/react`. Most of the work below is therefore **making implicit truths normative** and correcting three concrete falsehoods in the locked text (§17's gesture-safety claim, §15.2's `isIterating` guard, §17's tombstone/GC language). The amendments are grouped as in 004: **A** (correctness + Part I addenda), **B** (domain gaps), **C** (reactivity × the layers). Priorities are marked **(must / should / could)** per 004.

Every code citation was re-verified against the tree before enshrining; the verification log is §V at the end. No citation failed.

---

## A. Correctness and Part I addenda

### A3 (must) — Gesture write safety → §17 (interaction paragraph), §18.3; optional `trySet`

**Target:** §17's "Interaction code must read shared entities with `get`…" paragraph (~line 2556); §18.3's `GestureRecognition` + `DragSystem` code blocks (~lines 2640–2681).

**Motivation.** §17 claims a subsequent `ctx.edit(target).set(…)` on a remotely-despawned target "harmlessly no-ops via validate-on-read (§5.5)." That is **false against the shipped runtime**: `writeComponent` (runtime-store.ts:722–735) calls `assertAlive` (throws on a dead/stale handle) *and* throws on an absent component (`if (!this.has(e, c)) throw`). Validate-on-read exists only for **buffered `StructuralCommand`s at flush**, never for the immediate value-write path that `ctx.edit().set` takes. So the §18.3 example crashes in two places the frame a collaborator despawns the drag target or removes its `Position`.

**Normative — the corrected rule (replaces §17's false sentence).** Re-validation of a shared target MUST occur **in the same system run that writes it**, immediately before the write — not at top-of-frame. The justification: within one system body nothing structural can interleave (a remote fact lands at `sync()`, a buffered `ctx` command at the phase flush), so a presence check at the top of the body holds *for that body*. But **presence is not stable across phase boundaries**: a later phase in the same tick may have flushed a `ctx.destroy`, and the next frame's `sync()` may have applied a remote despawn. Therefore a top-of-frame liveness check does **not** license a write in a later phase. Replace §17's sentence with:

> Any entity a *local gesture* manipulates can be **despawned by a remote peer at a `sync()` boundary** (a remote despawn is structural, so it always applies — §13.3), or lose the edited component to a remote `removeComponent`. After that the local handle is stale, and — as shipped — a `ctx.edit(target).set(…)` **throws**: the value-write chokepoint (`writeComponent`) rejects both a dead handle and an absent component (it is *not* a silent no-op; validate-on-read covers only buffered structural commands at flush). The rule for interaction/gesture systems: **read shared targets with `get` and re-validate presence in the same run, immediately before writing; cancel the gesture if the target vanished.** Reserve `read` for entities whose lifetime the system itself owns (e.g. the local `Pointer` entity). A re-validation done at top-of-frame does not authorize a write in a later phase — nothing structural interleaves *within* a body, but presence is not stable *across* phase boundaries.

**Normative — rewritten §18.3 code.** Replace the `GestureRecognition` pointer-up branch and the whole `DragSystem` with:

```ts
const GestureRecognition = defineSystem(pointers, (batch, ctx) => {
  const input = ctx.firstOf(pointers);
  const p = ctx.read(input, Pointer);           // input entity is system-owned → read is fine (§17)
  const active = ctx.firstOf(activeDrags);

  if (p.down && active === undefined) {
    const hit = pickShapeAt(p.x, p.y);
    if (hit !== undefined) {
      const t = ctx.read(hit, Position);        // just hit-tested this frame → present by construction
      const g = ctx.spawn({ components: { DragGesture: { startX: p.x, startY: p.y, originX: t.x, originY: t.y } } });
      ctx.addRelation(g, Targeting, hit);
    }
  } else if (!p.down && active !== undefined) {
    const target = ctx.getRelation(active, Targeting);
    // Re-validate the SHARED target in THIS run, immediately before committing. A collaborator may
    // have despawned it (or removed Position) during the drag; ctx.get returns undefined instead of
    // throwing, so a vanished target cancels cleanly instead of crashing at pointer-up (§17, A3).
    const finalPos = target !== undefined ? ctx.get(target, Position) : undefined;
    if (finalPos !== undefined) {
      doc.transaction(tx => { tx.edit(target).set(Position, finalPos); }); // commit x/y only (§13.4)
    }
    ctx.destroy(active); // gesture ends either way — divergence resolves at commit, or was never committed
  }
});

const DragSystem = defineSystem(activeDrags, (batch, ctx) => {
  const { DragGesture } = batch.columns;
  const ptr = ctx.read(ctx.firstOf(pointers), Pointer); // Pointer entity is system-owned → read (§17)
  for (const r of batch) {
    const target = batch.getRelated(r, Targeting);
    // Presence guard, re-checked every run right before the write: writeComponent throws on a dead
    // handle AND an absent component (A3), so an unguarded ctx.edit(target).set would crash the frame
    // a peer deletes the target or its Position. If the target is gone, destroy the gesture entity.
    if (target === undefined || ctx.get(target, Position) === undefined) {
      ctx.destroy(batch.entity(r)); // deferred to the phase boundary; the drag has nothing to move
      continue;
    }
    ctx.edit(target).set(Position, {
      x: DragGesture.originX[r] + (ptr.x - DragGesture.startX[r]),
      y: DragGesture.originY[r] + (ptr.y - DragGesture.startY[r]),
    });
  }
}, { access: { write: [Position] } }); // Rule-2 writer (matches [DragGesture,…], writes Position on the target) — 001/C4
```

The `access: { write: [Position] }` on `DragSystem` is not incidental — it is a textbook 001 **Rule 2** writer (it matches on `DragGesture`/`Targeting` yet writes `Position` on the *target*), and under reactivity the undeclared write throws at the `writeComponent` chokepoint (C4).

**Could-level addition — `trySet`.** Add a presence-checked value write to `EntityEditor`:

```ts
interface EntityEditor {
  set<S>(c: Component<S>, v: S): void;      // throws on dead handle / absent component (unchanged)
  trySet<S>(c: Component<S>, v: S): boolean; // writes and returns true; returns false (no throw) if the
                                             // handle is dead or the component is absent. Still subject
                                             // to 001 access enforcement (an undeclared write throws).
}
```

`trySet` is the ergonomic form of the presence guard for interaction code that would otherwise wrap every write in a `get`. Deferred (could): the `get`-then-`set` pattern above is the shipped answer.

---

### A4 (must) — The mid-tick guard on the World facade → Part I addendum; rewrites §15.2's parenthetical

**Target:** §15.2's parenthetical asserting a store-side `isIterating` boolean (~line 2291); a new Part I addendum owns the mechanism.

**Motivation.** §15.2 states "the framework tracks a single `isIterating` boolean set only around system execution (§16)." **No such flag exists** — a tree-wide search finds neither `isIterating` nor any iteration counter (§V). Worse, Part I's ECSStore section forbids a store-side "am I iterating?" mode on principle (storage-ownership ≠ semantics-ownership). The guard the spec leans on is vapor; this addendum makes it real without violating that principle.

**Normative — the Part I addendum (new).**

- The **runtime** (the World-facade layer, not the `RuntimeStore`) hosts a single integer `iterationDepth`, **incremented before and decremented after every query dispatch** (`try`/`finally` around each `store.query(q).each(...)` in the tick loop and any other query walk). Nesting is possible (a system that iterates a sub-query), hence a depth counter, not a boolean.
- **World's structural methods throw when `iterationDepth > 0`, in ALL builds** — `world.spawn`/`world.destroy`/`world.addComponent`/`world.removeComponent`/`world.addTag`/`world.setRelation`/… and, by the same rule, the ephemeral store's structural `eph.*`. A mid-iteration archetype migration is **memory corruption, not a style violation**, so the check is unconditional (never compiled out). Value writes (`world.edit().set`, `eph.edit().set`) are **exempt** — they reorder no columns.
- The **store never consults `iterationDepth`.** It is a semantics concern owned by the facade; the store keeps storage-ownership only (the buffer-pool precedent). `EphemeralStore` reads the *same* runtime counter — it does not maintain its own — which is exactly the mechanism §15.2 already promises ("the framework tracks a single … set only around system execution").
- `world.sync()` reads the same counter and **throws when `iterationDepth > 0`** (a `sync()` from inside a system would drain remote facts mid-iteration — see C2).
- **Bench-gate before landing** (the `reactiveOn` lesson): confirm the counter's inc/dec adds no measurable per-frame cost. The cost is per-structural-op and per-query-dispatch, never per value write or per element, so it is expected to be free — but measure, per 004.

> **As-built addendum (2026-07-03, P3-M0R commit a0e4492 — three normative consequences of the Loro adapter's no-delete layout, for §13/§15 implementers).**
> 1. **Despawn vs concurrent remote edit is PER-CELL LWW, not delete-wins.** The adapter never deletes a per-entity container (deleting it loses the concurrent-recreation LWW race wholesale — one peer's entire cell set silently orphaned with a purely-additive fact stream); despawn clears the cells inside. Consequence: a remote value write concurrent with a despawn leaves that one cell alive — **partial-cell entity resurrections are legal converged states**, surfacing to reconcile as structural adds against an absent baseline (which §13.3 already handles). Cross-peer first-creation races cannot occur **only because keys are peer-prefix-minted** — raw `MutableSnapshot` callers must keep keys peer-unique.
> 2. **Transports MUST deliver per-peer causally in order, or exchange snapshots.** loro-crdt 1.13.6 has an upstream wasm panic (out-of-order mixed snapshot/update delivery with missing deps) that **permanently poisons the doc** (import/export/commit all die; unexported local work lost). The adapter quarantines itself the instant `import().pending !== null` (throws `PendingImportError`; resync = fresh doc + snapshot, exporting healthy local ops first) — but the transport constraint is normative for §14.2/§16.
> 3. **Undo is local-OPS-only, not local-EFFECTS-only.** Probes falsified the naive invariant: `undo()` re-asserts pre-op state as new lamport-latest ops, so it **clobbers causally-newer remote overwrites** of the same cells, and undoing a spawn commit despawns the entity together with peers' later components. §13.5's undo paragraph inherits this; M3 must make the accept-vs-gate decision explicitly (`TODO(M3-design)` in the adapter). Known residual: undo of a commit that CREATED an entity container deletes that container, and historical batches referencing it drop out of a receiver's per-commit replay (same class as the fixed dropped-batch bug, reachable only via undo) — bounded, documented, revisit at M3.

> **As-built addendum (2026-07-03, commits 9aae91b + 3b665af — the review widened the guard set).** The list above ships as specced (benched: all scenarios < 1%), plus three entries the review proved necessary: **`world.tick()`** throws on `iterationDepth > 0` AND on re-entrant tick, in all builds — an unguarded nested tick's phase flush applies archetype migrations under the live outer walk (repro: duplicate visitation), the exact corruption this section names; re-entrancy also cleared the outer tick's `ticking` flag, letting `reset()` slip its guard. `world.tick()`/`world.import()` also DEV-throw inside an observer/reactive emit (the mixed per-primitive in-emit guards otherwise half-apply a flush or a snapshot load — 005 §5.5/§10.6). And `world.sync()` drains a **snapshot** of the inbound list, so a binding unregistering itself mid-drain cannot skip its sibling's drain (teardown step 0 is exactly that call).

**Normative — rewrite §15.2's parenthetical.** Replace "the framework tracks a single `isIterating` boolean set only around system execution (§16), so the guard is one boolean read" with:

> the runtime (the World facade, *not* the store — §3 forbids a store-side iteration mode) hosts a single `iterationDepth` counter, incremented/decremented (`try`/`finally`) around every query dispatch (§16). A structural mutation on the World facade — and the ephemeral store's structural `eph.*`, which reads the *same* counter — throws whenever `iterationDepth > 0`, so the guard is one integer compare. The counter is a runtime concern (storage-ownership ≠ semantics-ownership, the buffer-pool precedent); the `RuntimeStore` never consults it. Value writes stay exempt (they reorder no columns).

---

### A5 (mixed) — Five small amendments

#### A5.1 (should) — Baseline memory honesty → §11 / §13.2

**Motivation.** The design never states what the baseline costs in memory; a reader may assume it is a diff or a lazy view.

**Normative — add (a full paragraph, e.g. as a note in §13.2).**

> **What the baseline costs.** The durable baseline is a **full second in-memory copy** of the document's converged state — a third copy alongside the runtime columns and Loro's own internal state. At editor scale (thousands of flat-component shapes) this is **single-digit megabytes**, and it is paid deliberately. The baseline **must not be lazily materialized** (not a diff over the runtime, not a Loro-backed view): reconcile performs a **per-cell baseline read at any moment** an inbound fact arrives — the value-vs-structure classification (§13.3) and the drag-in-flight compare (`runtime == baseline`) both index individual cells with no warning. A Loro-backed baseline view would always show *converged* truth rather than the *last-agreed* value, destroying the lagging-anchor semantics that make divergence detection work (§13.4); a diff-materialized baseline would add per-read cost to the reconcile hot spot. The full copy is the price of O(1) per-cell baseline reads and a correctly lagging anchor.

#### A5.2 (should) — Inbound-burst amortization → §13.3 / §16

**Motivation.** A large remote paste, or a late joiner catching up, drains many `ChangeBatch`es at one `sync()`. Because a batch applies atomically to completion (§13.3), a big burst is a one-frame hitch.

**Normative.**

> **v1 accepts the one-frame hitch, and says so.** `sync()` drains every pending `ChangeBatch` to completion in one frame (batch atomicity, §13.3), so a large inbound burst can stall a single frame. This is accepted for v1. The sanctioned future mechanism is a **time-budgeted, batch-granular drain**: apply whole `ChangeBatch`es until a per-frame time budget is exceeded, deferring the remainder to the next `sync()`. A single `ChangeBatch` is **never split** — batch atomicity is per-commit, and a half-applied batch would leak a transient state into a query or render (§13.3). **Late join:** import the document bytes into the `LoroDoc` **before** `attachDurable`, so attach projects one complete two-phase snapshot rather than an empty document followed by a catch-up burst.

#### A5.3 (should) — `undo()`/`redo()` are local-ops-only → §13.5

**Motivation.** §13.5 says undo/redo flow through reconcile but does not pin the undo *model*, leaving the classic collaborative-undo bug open.

**Normative — add one sentence to §13.5.**

> `undo()`/`redo()` are implemented via Loro's **`UndoManager`** (local-operation undo) — they invert only **this peer's** operations, producing new *forward* doc-facts that merge normally. They **never** use checkout / time-travel / version-vector reset, which would revert collaborators' concurrent edits too. This is why undo is "a source of normal doc-facts" (§13.5) and not a special runtime path.

#### A5.4 (should) — Delete the tombstone/GC language; enumerate the dangling surfaces → §17

**Motivation.** §17's "Referential integrity" paragraph says "clear/**tombstone** incoming relations" and "a periodic **GC** pass can sweep tombstones." No tombstone or GC mechanism exists: as built, `destroy` (runtime-store.ts:638–662) clears both directions of the reverse index **inline and eagerly** (`relations.clearEntity(e)` at :654), for local and inbound-remote despawn alike. The tombstone/GC sentences describe a system that isn't there.

**Normative — replace §17's referential-integrity paragraph's tombstone/GC sentences with.**

> Referential integrity is maintained **eagerly and inline**. On entity destroy (local *or* inbound-remote), the reverse relation index is cleared in **both directions immediately** (§5.5) — there is no tombstone and no GC pass. Exactly **two** residual dangling surfaces survive, both validated at read, never swept:
> 1. **`eid` component fields** — a raw `u32` handle may name a freed-then-reused slot. The sanctioned read is `readEid(e, C, field)`, which checks the referenced entity's generation and returns `undefined` when the reference dangles (runtime-store.ts:807–814).
> 2. **`key` fields** — a stored `EntityKey` may reference an entity that was despawned or was never present in this document. It is validated at `resolve(key)`, which returns `undefined` when the key does not resolve to a live handle.
>
> Both are read-time checks; nothing runs in the background.

#### A5.5 (could) — Drain order → §16.1

**Motivation.** With more than one `InboundSource` attached, §16 does not state the drain order. As built, `sync()` iterates `this.inbound` in registration order (world.ts:249–251: `for (const source of this.inbound) source.drain()`).

**Normative — add to §16.1.**

> When multiple `InboundSource`s are attached, `world.sync()` drains them in **attachment order** (the order `registerInboundSource` was called), **deterministically**, each source **to completion** before the next. Guidance: **attach durable before ephemeral**, so a frame's document truth lands before presence that may reference it (an ephemeral `EditingRef` pointing at a durable key resolves against an already-updated document). A source attached **mid-frame** (inside a system, or between `sync()` and the next frame) is drained at the **next** `sync()`, never retroactively within the current frame.

---

## B. Domain gaps

### B1 (must) — Ordering under collaboration → §3.3, §4, new §14.4, §18.1

**Target:** remove `ordered` from the §3.3/§4/§18.1 `defineRelation` surface and the §3.3 line-255 hierarchy-index promise; add §14.4; revise §18.1's `ZIndex`.

**Motivation.** As built, `defineRelation`'s `ordered` flag is **dead code**: schema.ts stores it (:62, :155, :162) but relations.ts never reads it — arity-"many" edges are unordered, deduped `Set`s (relations.ts:5, `manyForward`). The signature promises an ordering the runtime does not provide. (The flag is being removed from the API in a parallel change; this amendment records the **spec** side.)

**Normative — the spec surface removals.**
- Remove `ordered` from `defineRelation`'s options in the §3.3/§4 signatures and the `Relation` handle's fields.
- Remove the §3.3 (line ~255) promise of an ordered hierarchy index — no such index exists or is planned for v1.
- In §18.1, drop `ordered: false` from `ConnectedTo` and `Targeting` (see the revised lines below).

**Normative — new §14.4 "Ordering under collaboration."**

> Order is a **value**, not a relation flavor. To order siblings (z-order, list position), give each entity a single-field component holding a **fractional-index string**:
>
> ```ts
> const ZOrder = defineComponent("ZOrder", { key: "string" }); // an ordinary string column (a fractional index),
>                                                               // NOT the branded EntityKey "key" type (§14.3)
> ```
>
> This merges **whole-component, committer-wins** like any component (§13.4) — zero new doc-facts, zero runtime index, the adapter untouched. Readers **sort siblings at read time** by comparing order keys, with a **deterministic `EntityKey` tie-break** (equal or comparably-equal keys compare by `EntityKey`) so every peer produces the identical order. The sort is cheap and cacheable against the per-archetype structural stamp (002 §2.2).
>
> Two **pure** helpers are exported (no world state; §17 determinism):
>
> ```ts
> // A key strictly between a and b (either may be null for "before first" / "after last").
> // DEFAULT: deterministic midpoint — every peer computing between(a, b) gets the same key.
> // An injected rng adds jitter (to reduce interleaving contention) ONLY when supplied.
> function orderKeyBetween(a: string | null, b: string | null, rng?: () => number): string;
> function compareOrderKeys(a: string, b: string): number; // total order over fractional-index strings
> ```
>
> Inserting between two siblings is `orderKeyBetween(left, right)`; moving an element is a whole-component commit of its new key. Concurrent inserts at the same gap converge (both keys land; the tie-break orders them identically everywhere).

**Normative — revised §18.1 lines.** Replace `const ZIndex = defineComponent("ZIndex", { z: "i32" });` with the `ZOrder` line above, and drop the dead flag from the two relations:

```ts
const ZOrder = defineComponent("ZOrder", { key: "string" }); // fractional-index order key (§14.4)
// …
const ConnectedTo = defineRelation("ConnectedTo", { arity: "many" }); // `ordered` removed — was dead (B1)
const Targeting  = defineRelation("Targeting",  { arity: "many" }); // gesture → target
```

**Deferred with named forward path.** If subtree-move semantics are ever demanded (moving a node and all descendants as a unit), a **LoroTree** with its native fractional index is the forward path. **`MovableList` is rejected** — it keeps membership truth in two places (the list *and* the entity map), a real divergence hazard.

---

### B2 (must) — Text merge granularity → §13.4, §18.1; forward path in new §13.6 (non-normative)

**Motivation.** A `string` field is a component value like any other, so concurrent text edits do **not** merge — but the design never says so loudly, and a user will expect character-level CRDT merge from a collaborative framework.

**Normative — §13.4 (add) and §18.1.**

> A `string` field participates in **whole-component committer-wins** exactly like a numeric field. Concurrent text edits do **not** merge keystrokes — the **later committer's whole string wins**, and the other edit is lost (§13.4's committer-wins rule, applied to text). Consequences and rules:
> - Put text in **single-field components** (`Label { text: "string" }`), so a text edit and a sibling attribute edit are different cells and don't clobber each other (§13.4's schema-design rule).
> - **Commit at coarse boundaries** (blur / idle), not per keystroke — **SHOULD**-strength — so two people typing in different fields rarely collide, and the oplog stays compact.
>
> (§18.1's `Label` is already single-field — no change beyond this note.)

**Non-normative — new §13.6 "Forward path: a `text` field type."**

> A future `"text"` field type would give character-level merge. Reserved design (the layout carve-out is claimed **now** so text is never a breaking wire-format change):
> - The runtime column stays a `(string | null)[]` (unchanged storage, unchanged reads).
> - One **`LoroText`** container is carved out per text field inside the component entry — an explicit exception to the one-component-one-atomic-register rule (005 A2). Reserving the carve-out now means adding `"text"` later is additive, not wire-breaking.
> - **Critical adapter rule (the red-team fix):** the adapter must **NOT** call `LoroText.update(newString)`. `update` diffs the new string against the container's **current** state and would **delete concurrent remote characters** — committer-wins with extra steps, not a merge. Instead, compute the delta against the **baseline text** (the last-agreed value the baseline already stores, §13.2) and apply positional **insert/delete** ops. Diffing against the last-agreed value is what actually merges two peers' keystrokes.
> - **Storage obligation (small but real):** the baseline must retain the **agreed string per text field**. The baseline already stores the last-agreed value per cell (§13.2), so this is the text specialization of an existing obligation, not a new store — but it must be an actual string, not a hash, because the positional delta is computed against it.

---

### B3 (must) — Foreign schema on the wire → new §13.7

**Motivation.** Two peers on different builds share one document. A component/tag/relation one peer defines and the other does not must **survive** every local edit and echo on the ignorant peer — otherwise the first cross-version echo after the schemas diverge is silent data loss.

**Normative — new §13.7 "Foreign schema (mixed versions)."** Five rules; no version negotiation in v1 — name-keyed storage plus R1–R4 **is** the mixed-version story.

> **R1 — surface only locally-resolvable names.** The adapter surfaces `ChangeEvent`s only for component/tag/relation names present in the local schema. An **unknown name produces no event** and is not projected. An entity that also carries known components projects those normally — an unknown component never blocks a known one on the same entity.
>
> **R2 — outbound writes are per-component-name, never wholesale container rewrites.** The executor writes `doc.setComponent(key, name, v)` per component (and per tag/edge), touching only the names it changed. So an unknown component on an entity **survives every local edit and echo structurally**, not as a special preservation case — the ignorant peer simply never names, and therefore never overwrites, the container key it doesn't understand.
>
> **R3 — despawn deletes the whole container.** A despawn is entity-level intent, so it deletes the entity's whole container **including unknown components**. Dangling-edge note: an unknown-relation **edge from another entity** targeting the despawned key remains as a dangling fact for peers that *do* model that relation — the ignorant peer cannot clean an edge it doesn't represent. (Those peers validate it at read like any dangling edge, A5.4.)
>
> **R4 — unknown fields in a known component.** Projection writes the **known** fields only. A local commit **overlays** its known-field values onto the converged raw value (it must never strip a newer peer's `Position.z` that this build lacks). The surfaced `ChangeEvent` value is the **local-schema projection** (unknown fields stripped); the **baseline stores the stripped value**; and all compares — `cellEquals` (005 A1), the drag-in-flight `runtime == baseline` test — run over **local-schema fields only**. (Stripping before baseline is what keeps the compare well-defined; the raw value with the extra field lives in Loro, not the baseline.)
>
> **R5 — dev diagnostic.** A **one-shot** dev log per unknown name (component/tag/relation), not per occurrence: "received `Foo` — not in this build's schema; its data is preserved but not projected."

---

### B4 (must) — Inbound validation: the Part III policy layer → rides 005's canonical-encode

**Motivation.** Inbound values arrive from peers on other builds and from the wire; they may be malformed or out-of-range. The **mechanism** (canonical encode, `cellEquals`, partial-canon-rejects-one-fact) is 005 A1's `§9.5`. This amendment is the **Part III policy** that sits on top.

**Normative — Part III inbound-validation policy (references 005 A1 for `canon`/`cellEquals`).**

> - **Malformed** (wrong JS type, non-finite where a finite number is required, a missing no-default field, an unknown enum discriminant) → **reject that single fact.** Neither the runtime nor the baseline moves, so `runtime == baseline` still holds and the cell provably cannot strand — the next valid fact reconciles it normally (005 A1's partial-canon rule). Fields carrying a declared default are **filled**, not rejected.
> - **Representable-but-out-of-range** → treated **identically to a local write**: **modular wrap** for integer columns (300 into a `u8` is 44 via `ToUint8`, not a clamp or a truncation), `fround` for `f32`. Inbound and local writes canonicalize through the *same* `encode`/`decode` (field.ts:238–259; the typed array's store performs the wrap/round), so **no separate clamping policy exists**.
> - **Per-cell quarantine counter + dev warn**, mirroring §13.5's stranded-cell counter: count consecutive rejected inbound facts per cell and warn when a cell keeps rejecting (a schema mismatch, not a transient).
> - **Schema-evolution rule (cross-referenced from §17's migration note).** Adding a **required, no-default** field to a **live durable** component is a **wire-breaking change**: an older peer's write lacks the field, so it rejects on newer peers (malformed → missing no-default field). Therefore **new fields on live durable components MUST carry defaults.** (This is the durable analogue of the mechanical add-column-with-default migration §17 already describes for local snapshots.)

---

### B5 (must) — Ephemeral `peerId` is session-unique → §15.2, §15.3, §18.4

**Motivation.** The red-team found this **worse than the original comment**. With a **stable** ephemeral `peerId`, a crashed session's ghost keys arrive back **under your own prefix** on the next session, and the keepalive re-sends the whole partition via `encodePartition(myPrefix)` (§15.3) — so the new session **refreshes the ghosts' TTLs forever** and they never expire. This is the exact opposite of the durable requirement, where the peer prefix must *resume* across sessions (§14.2) so the key counter doesn't re-mint colliding durable keys.

**Normative — §15.2 / §15.3.**

> - The ephemeral `peerId` **MUST be session-unique** — `crypto.randomUUID()`, or `${userId}:${sessionNonce}` where `sessionNonce` is fresh per session. **Display identity** (name, color) lives in a component (`PresenceInfo`), **never** in the key prefix. (Contrast durable, §14.2: the durable peer prefix is *stable and resumed* because durable keys persist; ephemeral is the opposite — transient, TTL'd — so session-uniqueness is correct and there is no counter to resume.)
> - **The keepalive re-sends only keys THIS session minted** — never own-prefix keys learned from inbound. State the full interleaving: a crashed prior session's keys can arrive inbound; if the keepalive re-sent *every* own-prefix key (including learned ones), a single reuse incident would refresh those ghosts' timestamps on every keepalive and **make them permanent**. Re-sending only minted keys means an inbound ghost simply times out on its own.
> - **Dev warning on the inbound path:** a `remote` event delivering an **own-prefix key this session did not mint** = `"[strata] peerId reuse detected"` — the signature of a non-unique `peerId`.

**Normative — fix §18.4's example (line ~2727).** Replace `peerId: myPeerId` with a session-unique value:

```ts
const eph = createEphemeralStore(myLoroEphemeralStore, {
  peerId: crypto.randomUUID(), // SESSION-unique — never a stable id (B5). Display identity is in PresenceInfo,
  send: bytes => transport.broadcast(bytes), throttleMs: 16, ttlMs: 5000, // not in the key prefix.
});
```

---

### B6 (should) — v1 scope table → new §21

**Motivation.** The retrofit-hostile decisions (a cross-version echo after two builds diverge is data loss) must be visibly **in v1**; everything else needs a named forward path so "deferred" never reads as "unconsidered."

**Normative — new §21 "v1 scope."**

| **In v1 (normative now)** | **Explicitly deferred → forward path (rationale)** |
|---|---|
| Foreign-schema preservation (B3, §13.7) | Version negotiation → name-keyed storage + R1–R4 is the interim (no negotiation protocol earns its keep in v1) |
| Inbound validation: reject-don't-clamp + quarantine counter (B4) | — (retrofit-hostile; must ship with the wire) |
| Order-key pattern + `orderKeyBetween`/`compareOrderKeys` (B1, §14.4) | Ordered index → **LoroTree** fractional index, if subtree-move is demanded (`MovableList` rejected: dual membership truth) |
| Session-unique ephemeral peer ids + minted-only keepalive (B5) | — (a reuse incident is unrecoverable once ghosts are permanent) |
| Text = whole-component committer-wins (B2, §13.4) | Character-level merge → `"text"` field + `LoroText` with **baseline-delta** adapter (§13.6) |
| Held-cell ledger (C5) | v1-simpler fallback (pure drop + loud staleness paragraph) recorded as the cut option |
| Diagnostics: stranded-cell warn (§13.5), inbound quarantine counter (B4), one-shot unknown-name log (B3 R5) | Inbound-burst hitch → time-budgeted **batch-granular** drain, never splitting a batch (A5.2) |
| `SyncStatus` runtime resources (C7, §15.7) + `useResource` panel | `strata-ecs/tools` sync tab (C8) — the `SyncObserver` interface is normative now; the tab is fast-follow |
| Projection visible to reactivity by construction (C1); one settled boundary per frame (C2) | `ctx.ephemeral(eph)` mutator for structural ephemeral writes from systems (§15.2); `colW` lazy stamp (002); `useQuery` React hook (003) |
| `trySet` write-guard | `trySet` itself is could-level (A3) — the `get`-then-`set` pattern is the shipped answer |

---

## C. Reactivity × Parts II–IV (the 002/003 dividend)

### C1 (must) — Projection lands through the stamped primitives → §10.3, §13.1, §13.3; amends 002 §0/§6 (Part I addendum)

**Motivation.** Verified as-built: `projectComponent` stamps in **all three branches** (place, overwrite, migrate — runtime-store.ts:742–759); `place`/`unplace` bump the rows-version (:491); tag/relation ops bump `tagRelFrame`; `destroy` and `setResource` stamp — all behind the `reactiveOn` gate (:120–131). So remote edits, own-echoes, attach, and undo **already** light up `world.reactive`/`strata-ecs/react`. The only risk is a future fast path that bypasses the primitives.

**Normative — the rule and the guarantee.**

> **Projection MUST route through the stamped runtime primitives** — `projectComponent`, `ensurePlaced`/`place`, `projectRemoveComponent`, `destroy`, `applyTag`/`removeTag`, the relation ops, `setResource`, `removeResource`. **Raw-column projection is forbidden.** A future bulk-attach fast path is legal **only if it stamps equivalently** (bumps the same per-archetype/rows/tagRel/resource stamps a per-primitive apply would).
>
> **Guarantee (stated as a consequence):** a remote edit, an own-echo, attach, and undo become visible to `world.reactive` (all three tiers) and `strata-ecs/react` (`useComponent`/`useResource`) with **zero additional feed** — by construction, because they stamp exactly as a local write does.
>
> Attaching a store does **not** flip `reactiveOn`. The gate arms on first `world.reactive` access (:128–131), so a **collaborative world with no observers pays zero stamp stores** — the tax stays tied to the feature.

**Normative — amend 002 §0 item 1.** Replace it with:

> **1. Local-runtime, and projection-inclusive by construction.** Reactivity observes **runtime column changes — every write to a runtime column, whatever its origin.** In pure Part I that is only local writes. Once a durable or ephemeral store attaches, projection applies remote edits, own-echoes, attach, and undo **through the same stamped primitives** (§2.2), so they stamp and notify **identically to a local write**, with no additional feed. The earlier framing ("local-runtime only; the collaborative feeds are deferred future work") is **superseded** (006 C1): the feeds are not deferred, they are automatic. The layer is local-runtime *until Parts III–IV attach*; the collaborative layers feed the same stamps by construction. Attaching a store does **not** by itself arm reactivity — `reactiveOn` flips on first `world.reactive` access, so a collaborative world with no observers still pays zero stamp stores.

**Normative — amend 002 §6's "Not remote/collaborative change" bullet.** Replace with:

> - **Remote/collaborative change — visible by construction (RESOLVED, 006 C1).** Durable reconcile and ephemeral projection reach the runtime through the stamped primitives (`projectComponent`, `ensurePlaced`, `destroy`, tag/relation ops, `setResource`), so a remote edit, an own-echo, attach, or undo lights up `observeQuery`/`observeValue`/`useComponent` exactly as a local write does — **no additional observer feed exists or is needed.** The one requirement (now normative): projection MUST route through those primitives; raw-column projection is forbidden. What is *not* automatic is a settled boundary for the drained facts — that is the frame contract (006 C2): stamps written during `sync()`'s drain carry the current frame and are observed at that frame's single `notify()`.

---

### C2 (must) — One settled boundary per frame → new §16.4

**Motivation.** With C1, drained facts stamp — but only a defined frame boundary makes them observable coherently. The subtle hazard: the per-primitive observer-emit guards deliberately **do not** cover the projection primitives (`projectComponent`/`ensurePlaced` are unguarded — they *must* run mid-drain), while the structural mutators (`removeComponent` via `projectRemoveComponent`, `destroy`) **are** guarded (`rejectMutationInEmit` → silent no-op). So a drain that ran *inside* `notify()` would **half-apply a batch** — adds land through the unguarded `projectComponent`, removes get swallowed by the guarded `removeComponent`/`destroy` — violating batch atomicity in the worst way.

**Normative — new §16.4 "The frame contract."**

> The frame is `sync() → tick(s) → notify() (exactly once) → render` (matching 002 §4.1's loop). Stamps written during `sync()`'s drain carry the **current** frame; the single `notify()` observes them — **remote-edit-to-observer latency is zero frames.**
>
> - **`drain()` DEV-asserts `!inObserverEmit` at entry** — one check per drain. This is the reliable guard: the per-primitive emit guards are **mixed by design** (projection primitives unguarded so they can run mid-drain; structural mutators guarded), so a mid-`notify()` drain would half-apply a batch (adds via unguarded `projectComponent`, removes swallowed by guarded `removeComponent`/`destroy`). The drain-entry assert forbids the whole situation once, rather than relying on per-primitive checks that deliberately disagree.
> - **`world.sync()` throws when `iterationDepth > 0`** (rides A4) — a `sync()` from inside a tick would drain remote facts mid-iteration.
> - **Extend the `setResource`-in-emit `devWarn` to `writeComponent`.** `setResource` already warns when called from inside a reactive callback (runtime-store.ts:904–911, because it stamps the current frame — already seen by every watch this pass — so it is silently unobservable). `writeComponent` has the same property and no such warning today; add the mirrored `DEV && inObserverEmit → devWarn` to it.
> - **Batch atomicity (§13.3) + poll-at-boundary (002 §4.1) compose.** `drain()` runs each batch to completion before `notify()`, so an observer can **never** see a half-applied `ChangeBatch`. **No "suppress observers during drain" mechanism exists or is needed** — the composition is the guarantee.

---

### C3 (must) — Attach fires observers once: the first-paint rule → §13.1

**Motivation.** Attach projects a whole document through stamping primitives (C1). A user will expect either a storm of per-entity fires or emitter-style retro-fire on late subscription; neither is what happens, and the truth must be stated.

**Normative — add to §13.1.**

> **Attach MUST NOT suppress stamps, and it is not a storm.** The poll model coalesces attach's projection to **at most one fire per observer** at the next `notify()` ("the document arrived — paint"). Registration timing, stated exactly:
> - **Pre-attach observers** see attach at the next `notify()`: attach's stamps are newer than their `lastSeen`, so each fires once.
> - **Post-attach registrations do NOT retro-fire.** A fresh observer baselines at `frame − 1` (002 §4.1a; reactive.ts:114/:123), so writes stamped *before* it subscribed never fire. It reads current state through the **snapshot path** — a React component mounted after attach renders the projected value **immediately** (its `getSnapshot`/`peek` reads the current column), it just doesn't get a change *callback* for the pre-existing state.
> - **Detach needs no special rule.** Teardown routes through `destroy()`, so entity/value death hooks fire `undefined` (002 §3.4) and Tier-1 observers fire as membership empties (rows/tagRel versions bump). No detach-specific observer code exists.

---

### C4 (must) — 001 enforcement × projector/executor → §10.3, §12.3; amends 001 §2.2

**Motivation.** Projection runs with `currentSystem === null`, so the 001 chokepoints no-op (`enforceColAccess`/`enforceWriteAccess` both early-return when `currentSystem === null` — runtime-store.ts:452, :468). But a `doc.transaction` **inside a system** applies pre-existing-component value writes synchronously through `writeComponent` with `currentSystem` **set** — so the write chokepoint fires. §12's `CommitOnSettle` example does exactly this and, as written, **throws in dev** once any observer arms enforcement (it never declares `access.write`).

**Normative.**

> **Projection is exempt by construction** and **MUST NOT** acquire an access envelope: it runs at `sync()`/attach with `currentSystem === null`, so `enforceColAccess`/`enforceWriteAccess` no-op. Attributing projection to a "system" would be a category error — projection is not a system.
>
> **The one crossing:** a `doc.transaction` inside a system body applies a **pre-existing-component** value write synchronously through `writeComponent` with `currentSystem` set (§13.2). Such a system **MUST declare those components in `access.write`** — this is correct, not incidental: the write is same-phase-visible and must be stamp-attributed exactly like any other system value write.

**Normative — rewrite §12's `CommitOnSettle` example.**

```ts
const CommitOnSettle = defineSystem(
  query([Position, Settling]),
  (batch, ctx) => {
    for (const r of batch) {
      const e = batch.entity(r);
      const p = batch.col(Position);
      if (isSettled(p.x[r], p.y[r])) {
        doc.transaction(tx => tx.edit(e).set(Position, { x: p.x[r], y: p.y[r] }));
        // ↑ tx.edit().set on a PRE-EXISTING Position is a synchronous writeComponent with currentSystem
        // set (§13.2), so it hits the 001 write chokepoint. Position MUST be in access.write, exactly
        // like any same-phase value write — otherwise this throws in dev once an observer arms 001 (C4).
      }
    }
  },
  { access: { write: [Position] } }, // REQUIRED: the durable value-commit writes Position synchronously
);
```

One-line callout to add beneath it: *without the `access.write` declaration this example throws in dev the moment any observer arms 001 enforcement — the durable commit is a real same-phase `Position` write.*

---

### C5 (should) — Held-cell ledger replaces the pure drop → §13.3, §13.5

**Motivation.** A drag that **reconverges to baseline without committing** strands the dropped remote value **forever**: no future fact re-delivers it, and the stranded-cell warning (§13.5) never fires because the drops stop once the cell reconverges. The value is silently lost.

**Normative — the ledger (§13.3), with mandatory supersession rules.**

> The binding keeps a **held-cell ledger**: the **latest held value per cell** — the most recent remote value the drag-in-flight guard dropped (§13.3's `(remote, value)` drop branch).
>
> - **Sweep at the end of every drain, including empty drains.** Reconvergence happens during ticks, *between* drains, so a drain that applied no new facts must still sweep — otherwise the silent-reconverge case is never caught. The sweep applies a held value **only** on the exact silent-reconverge case: `runtime == baseline` for the cell (the drag ended, the cell agreed) **and** the held entry survived the supersession rules below → apply the held value via `projector.applyComponent` and advance the baseline.
> - **Supersession rules (MANDATORY — the naive sweep resurrects conflict-losing values).** A held entry is **cleared** by:
>   - **(a)** any **applied value fact** for the cell (own-echo or remote) — a newer value supersedes the held one;
>   - **(b)** the **local commit's synchronous agreement** (§13.2) — the held value **lost** committer-wins, so it must be dropped, not resurrected;
>   - **(c)** any **structural fact** on the cell (add/remove/despawn) — else the sweep's add-if-absent `projectComponent` would **resurrect a removed component**.
> - **Holds never stamp or notify** (the runtime didn't change when a value was dropped). The **apply** stamps at the frame of application (it is a real runtime change), so reactivity observes the recovered value at that frame's `notify()` (C2).
>
> **§13.5's stranded-cell warning gains held-count detail** — report how many held values are outstanding for the cell alongside the consecutive-drop count.

**Recorded cut option (the v1-simpler fallback).** Keep the pure drop and add one loud staleness paragraph: a value dropped by a drag that reconverges without committing is **lost**; recover it by reading the converged value (`doc.getComponent`) and committing it. The ledger is ~30 lines and feeds the sync tab (C8), so it is the chosen path — but the fallback is recorded as legitimate if the ledger is cut.

---

### C6 (should) — T0 lifecycle origin → `observe.ts` contract widening

**Motivation.** Tools want to attribute a spawn/destroy to its source. As built, `onSpawn?(e)` / `onDestroy?(e)` (observe.ts:35–37) carry no origin.

**Normative — the design (Origin-threading variant).**

> `onSpawn`/`onDestroy` gain a **backward-compatible extra param** `origin?: Origin`, constructed **only inside the `observerList !== null` branch** (zero cost when no observer is attached):
>
> ```ts
> type Origin = "local" | "remote" | "attach" | "import";
> interface WorldObserver {
>   onSpawn?(e: Entity, origin?: Origin): void;   // origin added (backward-compatible)
>   onDestroy?(e: Entity, origin?: Origin): void; // 'import' never reaches destroy (see below)
>   // …existing hooks unchanged…
> }
> ```
>
> **Reconcile threads its batch's `Origin` through the projector**, so the value is honest: `'local'` (your own `ctx.spawn`/`world.spawn`, and your own committed transaction's own-echo), `'remote'` (a peer's projected fact), `'attach'` (the two-phase attach projection), `'import'` (snapshot load).

**Motivation for threading (the red-team caveat).** A flat `"projection"` value would **lie for destroys**: your own `tx.destroy` reaches the runtime via **own-echo projection**, so a flat value would report your own delete as a collaborator's action. Threading the batch's real `Origin` makes an own-echo destroy report `'local'` and a peer's report `'remote'`.

**Note.** The destroy-side `'import'` value is **dropped** — import is pure creation and never destroys (§13.1), so it is unreachable on `onDestroy`.

---

### C7 (should) — SyncStatus resources riding 003 → new §15.7 + a §12.4 paragraph

**Motivation.** A React sync panel should be `useResource(world, DurableSyncStatus)` with zero new observer machinery (003 gives resource reactivity). The trap: a naively-updated status resource re-renders every frame on an **idle** network, because `sync()` drains unconditionally each frame (world.ts:249–251).

**Normative — new §15.7 "Sync-status resources."**

> The bindings maintain **runtime-local** resources (not durable, not synced — set via `world.setResource` at boundary points only):
>
> ```ts
> const DurableSyncStatus = defineResource("DurableSyncStatus", {
>   pendingInbound: "u32", heldCells: "u32", lastAppliedFrame: "u32", droppedThisSession: "u32",
> });
> const EphemeralSyncStatus = defineResource("EphemeralSyncStatus", {
>   peerCount: "u16", lastInboundFrame: "u32",
> });
> ```
>
> - **Fields MUST be activity-driven.** `lastAppliedFrame` is bumped **only when ≥1 fact was actually applied** in a drain — **never** a per-drain `lastDrainFrame`, which would advance every frame on an idle network (sync drains unconditionally) and re-render the panel forever.
> - **Producer-side set-on-change is MANDATORY.** The binding compares each field against the last value it set and **skips `setResource` when nothing changed** — otherwise the resource stamps every frame (C2) and the panel re-renders on an idle network anyway.
> - **The peer LIST stays a query** (`[PresenceInfo, Not(Local)]`), never a resource — it is per-entity data. `peerCount` on the resource is a set-on-change scalar, not the list.
> - **Connection state stays app-owned.** The binding never sees the transport, so it cannot report connectivity. **Bless the app-defined `ConnectionState` resource pattern:** the app sets its own `ConnectionState` resource from its socket events, and a `useResource(world, ConnectionState)` panel reads it — the same machinery, owned where the knowledge lives.

**Normative — §12.4 paragraph (add).**

> The binding sets `DurableSyncStatus` **at drain boundaries only** (end of `drain()`), set-on-change, so a `useResource(world, DurableSyncStatus)` panel updates exactly when sync activity actually changes — never per idle frame.

> **As-built addendum (2026-07-04, Part III complete — commits ade0ef3/e62540d/3e58959/dc4ade4/64a668d; the shipped forms where they diverge from the sketches above and from design.md).**
> 1. **`attachDurable(world, store)` is a package-level function**, not the `world.attachDurable(...)` method design.md §14.2/§20 sketch — the core never names a durable type; `registerInboundSource` is the entire coupling (§12.1's own principle, taken to its conclusion).
> 2. **Drain order is remote-then-local-echo and it IS load-bearing.** design.md §9.4/:1414's claim that own-echo and remote batches "reach the same result regardless of which drains first" is **falsified** for structural×value races (M4R, repro-verified). The shipped rule that makes order safe: **own-origin echoes are commit-time-stale — every apply they drive, value AND structural (add/remove/despawn), re-reads the doc's CONVERGED state at drain time; the payload drives classification only.** Corollaries: the held-ledger sweep applies the converged re-read (the stored entry only marks pendency); supersession (b) fires on EVERY committed value including `addComponent`/spawn payloads (the adapter's net frontier diff collapses a same-tx remove+add into one `component-set`, so rule (c) can never see it); and despawn-survival reconciliation runs for BOTH origins (`exists` has no concurrent writer, so a remote despawn fact fires even when a concurrent set won a cell — the no-delete layout's partial-resurrection case, closed reconcile-side).
> 3. **`DurableSyncStatus` as shipped:** three fields — `pendingInbound`/`heldCells`/`lastAppliedFrame` (`droppedThisSession` is dropped; fold that into the C8 observer if ever needed). `lastAppliedFrame` is a **monotonic per-applied-drain counter**, not a world tick number (a sync-only viewer still sees it advance; two applied drains in one tick stay distinct). Publishing happens at **drain AND enqueue boundaries** (the §12.4 paragraph above under-specified: `pendingInbound` is measured at enqueue, so enqueue must publish too), always set-on-change. **Detach removes the resource** (`useResource` reads `undefined` when unattached). C8's SyncObserver remains unimplemented (fast-follow as designed); the binding's internal apply-counting projector hook is its natural `onFactApplied` emit site.

---

### C8 (could) — SyncObserver + the strata-ecs/tools sync tab → tools section

**Motivation.** The sync tab needs emit sites inside the drain. Those sites are **cheap to build in now, expensive to retrofit** — so the interface shape is normative now even though the tab is fast-follow.

**Normative — `binding.observeSync(obs)` under the T0 contract.**

> `binding.observeSync(obs): Unsubscribe`, under **exactly** the T0 `WorldObserver` contract (observe.ts): **zero-cost when unattached** (branch-on-null), **read-only**, **must-not-throw** (a throw is swallowed and `devError`'d), and — because callbacks fire **mid-drain** — they **MUST NOT mutate** the world. The interface shape is **normative now**:
>
> ```ts
> interface SyncObserver {
>   onEnqueue?(batchCount: number): void;                    // ChangeBatch(es) landed in the pending queue (commit/applyRemote)
>   onDrainStart?(pending: number): void;                    // drain() begins
>   onFactApplied?(kind: string, key: EntityKey, comp?: string): void; // one normalized fact applied
>   onHold?(key: EntityKey, comp: string): void;             // a value fact held off (drag-in-flight guard, §13.3)
>   onHeldApplied?(key: EntityKey, comp: string): void;      // a held value applied by the ledger sweep (C5)
>   onDrainEnd?(applied: number, held: number): void;        // drain() finished
> }
> ```
>
> The `strata-ecs/tools` **sync tab** that consumes this is **fast-follow** — only the emit sites and interface are specified now.

---

## V. Citation verification log

Every 004 code citation was re-read before enshrining. All held; no adaptation was needed.

- **A3 — `writeComponent` throws** (runtime-store.ts:722–735): confirmed — `assertAlive(e, "writeComponent")` throws on a dead/stale handle, and `if (!this.has(e, c)) throw` on an absent component. §17's "harmlessly no-ops via validate-on-read" is false. Validate-on-read applies only to buffered structural commands at flush.
- **A4 — no `isIterating`/`iterationDepth`** anywhere in `src/` (tree-wide grep, §V run): confirmed — §15.2's asserted guard exists nowhere; the counter is genuinely new.
- **A5.4 — eager despawn** (runtime-store.ts:638–662): confirmed — `relations.clearEntity(e)` both-directions inline at :654; no tombstone or GC. Dangling surfaces validated at read: `readEid` (:807–814, generation check), `resolve(key)` (key fields).
- **B1 — dead `ordered` flag:** confirmed — stored at schema.ts:62/:155/:162; never read in relations.ts (arity-many is an unordered, deduped `Set`, relations.ts:5). `"key"` field type shipped (field.ts:12–38, `EntityKey` + `entityKey()`), so 004's REFUTED note holds.
- **B4 — canonicalization** (field.ts:238–259): confirmed — `eid` encodes as `>>> 0`; integer/`f32` columns wrap/round on typed-array store; string/`key` pass through. No separate clamp path.
- **B5 — §18.4 `peerId: myPeerId`** (design.md:2727): confirmed as the stable-id example to fix.
- **C1 — projection stamps** (runtime-store.ts:742–759): confirmed — `projectComponent` stamps in place, overwrite, and migrate branches; `place` bumps the rows-version at :491; `reactiveOn` gate at :120–131; `enableReactive` on first `world.reactive` access (not on attach).
- **C2 — mixed in-emit guards:** confirmed — structural mutators reject in-emit (`destroy` :640, `addComponent` :695, `removeComponent` :712, `addTag` :822, `removeTag` :831, `setRelation` :854, `addRelation` :866, `removeRelation` :878); `projectComponent` is **unguarded** (:742, must run mid-drain); `writeComponent` has **no** in-emit check (so C2's `devWarn` addition is real); `setResource` in-emit `devWarn` present at :904–911 (the mirror source).
- **C3 — registration frame boundary** (reactive.ts:112–124): confirmed — `advanceFrame()` + `lastSeen = frame − 1`, no retro-fire. Death drain at :246–266.
- **C4 — enforcement chokepoints** (runtime-store.ts:449–475): confirmed — both early-return on `currentSystem === null` (projection exempt); `writeComponent` calls `enforceWriteAccess` at :727. `beginSystemAccess`/`endSystemAccess` window in the tick loop (world.ts:198/:230). §12's `CommitOnSettle` (design.md:1699–1716) has no `access` and would throw once armed.
- **C6 — `onSpawn`/`onDestroy`** (observe.ts:33–49): confirmed — `(e: Entity)` only, so an `origin?` param is backward-compatible; the file's contract (zero-cost/read-only/must-not-throw/roster copy-on-write) is the T0 contract C8 reuses.
- **C7 — `sync()` drains unconditionally** (world.ts:249–251): confirmed — `for (const source of this.inbound) source.drain()` runs every frame, which is why `lastAppliedFrame` (not `lastDrainFrame`) and set-on-change are mandatory.

---

## Open questions

1. **`orderKeyBetween` string encoding.** §14.4 fixes the *semantics* (deterministic midpoint, `EntityKey` tie-break, injected-RNG jitter) but not the concrete fractional-index alphabet/format. A base-62/LexoRank-style encoding is the obvious choice; pinning it is a Part III implementation detail, flagged so it isn't discovered late.
2. **`SyncStatus` field set (C7).** The listed fields (`pendingInbound`, `heldCells`, `lastAppliedFrame`, `droppedThisSession`; `peerCount`, `lastInboundFrame`) are a starting set. The `SyncObserver` emit sites (C8) are the source of truth for what is cheaply available; the resource fields should be reconciled against them when C8's sites are built.
3. **Held-cell ledger memory (C5).** The ledger holds one value per silently-diverged cell. In pathological cases (many cells dragged and abandoned without commit) it could grow; a cap or eviction policy is unspecified. Likely a non-issue at editor scale (abandoned drags are rare), but noted.
