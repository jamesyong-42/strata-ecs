# Patch Note 001 — System Access Declaration (foundation for reactivity)

**Status:** Proposed — amended 2026-07-02 after an implementation-fit + adversarial review against the code as built (T0/T1 shipped; example complete).
**Scope:** Part I (runtime core) — system definition and the tick pipeline
**Baseline:** `design.md` (locked). This note is an *amendment*; it does not modify the baseline. Section references (§N) point into the locked doc.
**Depends on:** nothing mechanically, but **001 and 002 land together**: 001's honesty enforcement (Rule 3) only arms when reactivity attaches, so standalone declarations would be unverified prose and the advisory diagnostics would run on unreliable data. There is no useful 001-without-002 increment.

---

## 0. Why this note exists, and what it deliberately does not do

This is **Part A of a reactivity design**: the mechanism that lets user code observe/react to component value changes (and integrate with React) without putting per-write bookkeeping on the hot path. Reactivity itself (observers, tiers, the React binding) is **out of scope here** — it will be its own note. This note specifies *only* the substrate reactivity needs from the runtime core: **a way for a system to declare which component columns it reads and writes.**

The framing decision that governs everything below (settled before drafting): **in v1, access declaration is additive metadata that does NOT change execution semantics.** Systems still run in positional pipeline order (§7.1's "array order is execution order — no constraint solver, no `before`/`after`"). This note does **not** introduce a scheduler, does **not** reorder systems, and does **not** change any timing rule in §0. It adds a *declaration* that three things consume — change detection, dev-mode enforcement, and advisory diagnostics — none of which alter the order systems run. The declaration is also the exact input a future parallel scheduler (§17) would need, declared now but inert with respect to v1 ordering.

This preserves the baseline's stated values: array-order-is-execution-order stays true, and you pay for the feature only when you use it (§0's Part I "usable on its own" promise is unbroken — a pure-Part-I user who never observes anything declares nothing and pays nothing).

---

## 1. The change, in one paragraph

A system gains an optional `access` field in `defineSystem`'s options object, declaring the component columns it may `write` and those it treats as read-only (`read`). The declaration is the **union over all conditions** (an upper bound on what the system may touch on any frame), covers **value read/write only** (never structural changes — those stay in the command buffer, §5.4), and is **optional in general** but becomes **required-and-dev-enforced** for any writing system once the reactivity layer is active. In v1 it drives no reordering; it feeds change detection (Patch Note 002), dev-mode honesty checks, and advisory conflict diagnostics.

---

## 2. Spec

### 2.1 Types and signature

Amends the `defineSystem` signature. The baseline shows two forms — the positional `defineSystem(query, body)` (§ line 994) and the options form `defineSystem(query, body, opts?: { runIf })` (§ line 1187). This note **unifies them into the single options-bearing form** and adds `access` alongside the existing `runIf`:

```ts
interface SystemAccess {
  write?: Component[];   // component columns this system may MUTATE (value writes). Union over all conditions.
  read?:  Component[];   // component columns treated as READ-ONLY. Defaults to the system's query components
                         //   that are not in `write` (a system reads what it queries unless declared otherwise).
}

// unified signature (supersedes both baseline forms; runIf unchanged, access added).
// `name` shipped with the T0 observability work (the tools' system labels) and stays:
function defineSystem(
  query: Query,
  body: (batch: Batch, ctx: SystemCtx) => void,
  opts?: { runIf?: Condition; name?: string; access?: SystemAccess },
): System;
```

`SystemAccess` lists **components only** in v1 (see §5, Non-goals — resources are a deliberate future extension). Tags and relations are not listed: they are query-membership filters, not value columns, and their changes are structural (buffer-carried, §5.4), not value writes.

### 2.2 The three rules that keep a separate declaration honest

A separate `access` block is a second source of truth that *could* drift from what the body actually does. These three rules are what make it trustworthy rather than a silent-corruption risk; without them, a separate declaration is net-negative.

**Rule 1 — `access.write` is the envelope (union over all conditions), not a per-frame description.** A system that writes `Position` only when a drag is live still declares `write: [Position]`. The declaration is an *upper bound* on what may happen on any frame. Every consumer is designed to tolerate an upper bound: a declared-but-not-written column simply produces no change-detection stamp on frames where the write didn't occur (Patch Note 002 handles the stamp-on-actual-write side). So conditional access — a system that touches a component only under some condition — is correct by construction, requiring no special handling.

**Rule 2 — the declaration MAY name components the query does not.** This is the specific reason a separate `access` block is preferable to encoding access in the query (e.g. a `Write(Position)` query wrapper). A system may *match* on `[Draggable]` yet *write* `Position` — the set it filters by and the set it touches are genuinely different. `access.write: [Position]` expresses the write set directly without forcing `Position` into the query where it does not belong (the system writes `Position` on entities the query yields, resolving the handle via `ctx.edit(e)`; the declaration grants permission, the query need not mention it). Encoding access in the query would also require a `read()/write()` term vocabulary that clutters the most-written construct; the separate block keeps the query clean.

**Rule 3 — dev-mode enforcement makes the declaration honest; production trusts it and pays nothing.** This is the load-bearing rule, **amended after implementation review**: the originally-proposed per-element write-asserting wrapper is not viable as the default — a Proxy over a typed array breaks `instanceof`, `.set()`/`.subarray()`, and GPU-upload paths, costs 10–100× per access (poisoning the T0 per-system profiler in exactly the builds it runs in), and makes dev diverge behaviorally from prod. Enforcement is therefore layered:

- **Enforced (dev, whenever reactivity is active): the accessor-level check.** Calling `batch.col(C)` (or `batch.colW(C)`, 002 §2.3) for a `C` in neither `access.write` nor `access.read` **throws immediately**, naming the system and component — before any element is touched. Set membership once per `batch.col(C)` call (once per archetype per system per frame). The returned columns stay the raw typed arrays, dev and prod identical.
- **Enforced exactly (dev, all paths): the edit chokepoint.** Writes via `ctx.edit(e).set(C, v)` route through `writeComponent`, which asserts `C ∈ access.write` for the running system precisely — no wrapper needed. This is what checks Rule 2's headline case (writes to entities outside the query's archetypes).
- **Opt-in strict mode (tests only): per-element assertion.** A test-build flag may wrap columns to assert every element write and record the precise written set. This is a CI tool for auditing declarations, never the default dev experience.

**Production returns the raw typed-array views with no wrapper and no check — byte-for-byte identical to today's hot path.** The honesty guarantee, stated exactly: a declaration that under-claims throws in dev *when that code path runs with reactivity attached*. Coverage of conditional branches is the test suite's job (run reactive tests in strict mode); production always trusts the declaration — an under-claim that survives to prod shows up as stale UI, not corruption. This is the same trade flecs/DOTS make.

### 2.3 Default when `access` is omitted

- **Omitted entirely** ⇒ `read` defaults to the system's query components; `write` is empty. A **pure-reader** system (a render/extract system that only reads) needs no declaration and is fully correct.
- **A system that writes a column without declaring it in `write`** ⇒ **dev-mode error** on the first write through the enforcement wrapper (Rule 3), when reactivity is active. So `access.write` is effectively *mandatory for any writing system under reactivity*, enforced at the call site rather than by convention.

The declaration burden therefore falls **only on writers, and only when reactivity is on**. This ties the ergonomic tax to the feature (§2.4).

### 2.4 The tax is tied to the feature

`access` is **optional in the base runtime**. A user running Part I with no reactivity (§0: "if you want a fast local ECS and nothing else, you can stop after Part I") declares no `access`, and dev-mode enforcement is off — zero tax. The moment the reactivity layer is attached, dev-mode enforcement switches on and undeclared writers throw in dev. This keeps the "pay only for what you use" property the baseline holds throughout: the cost of honest declarations is incurred exactly when their benefit (reliable change detection) is wanted.

---

## 3. What `access` drives in v1 (three consumers, none reorder)

### 3.1 Change detection (the reactivity substrate — detailed in Patch Note 002)

After a system runs, the tick stamps the columns it wrote. **Amended — the stamp scope is now specified, because both naive readings break a claim:** stamping only the query's matching archetypes misses Rule-2 writes (targets outside the query); stamping *every* archetype containing `C` over-fires world-wide. The resolved scheme has two routes:

1. **Blanket route (batch writes):** for each archetype in the system's query-match list, for each `C ∈ access.write`, stamp **iff `archetype.hasComponent(C)`** — the guard matters because Rule 2 lets `access.write` name components the matched archetypes may lack.
2. **Precise route (edit-path writes):** `ctx.edit(e).set(C, v)` stamps `C` on **`e`'s actual archetype** at the `writeComponent` chokepoint, wherever that entity lives. This is what makes Rule-2 writes (match `[Draggable]`, write `Position` on arbitrary handles) correct — they are stamped exactly, not blanket-approximated.

`access.write` tells the tick *which columns are blanket candidates*; the edit chokepoint needs no candidates at all. Cost: a handful of integer writes per system per frame (route 1) plus one integer store inside an op already doing O(fields) work (route 2) — never per element.

### 3.2 Dev-mode honesty enforcement

Per Rule 3 — asserts the body's actual accessor use matches the declaration. Dev-only, compiles out.

### 3.3 Advisory conflict diagnostics (does NOT auto-resolve)

Because v1 does not reorder, `access` does not *fix* ordering — but it can *warn*. At pipeline construction or first tick, the framework may walk declared access within a phase and surface **advisory** dev diagnostics:
- Two systems in the same phase both writing the same component → a potential order-dependence the author should be aware of (warn, not error — they may have ordered deliberately).
- A system reading component `C` positioned before one writing `C` in the same phase → a likely "reads stale `C`" bug (warn).

These are **advisory only** — they help the author hand-order correctly without taking ordering away. This respects §7.1's "array order is execution order, you're in control" while giving `access` immediate utility beyond reactivity: the doc won't auto-order, but it will *tell you* when your manual order looks data-inconsistent. Compiles out of production.

### 3.4 Guidance for conditional writers (added after review — the Tier-1 over-fire trap)

Blanket stamping (002 §2.3) stamps a system's `access.write` on every frame **the body runs** — a system with `runIf: () => true` that writes only during a live drag stamps `Position` at 60fps while idle, and a Tier-1 canvas observer then repaints continuously (Tier 3's equality check protects only Tier 3; DOTS' chunk-version false positives are the cautionary precedent). Two blessed patterns, stated here because §7.1's "an empty query iterates free, don't bother gating" advice pulls the other way:

- **`runIf`-gate conditional writers** when reactivity is on: a gated-off system doesn't run, so it doesn't stamp. (The canvas example's `DragMove` already does this — `runIf: mode === "drag"` — which is why its idle frames are stamp-free.)
- Or use the **lazy write-accessor `colW`** (002 §2.3) in systems where even a run-but-wrote-nothing frame must not stamp.

Under reactivity, gating a conditional writer is not a micro-optimization — it is what keeps Tier-1 observers quiet at idle.

---

## 4. How this folds into the (locked) doc — ripple map

This note is the change; the following is where a *future* edition would integrate it, mapped to real anchors. Nothing below is applied to the locked baseline.

| Baseline anchor | Integration |
|---|---|
| §7.1 (§ line 834, "Pipelines are values") | Add a subsection (e.g. §7.3 "Access declaration") introducing `access`: what it declares, envelope semantics (Rule 1), that it names non-query components (Rule 2), that in v1 it does **not** reorder (execution stays positional), and that it feeds change detection + dev-enforcement + diagnostics. Primary conceptual home. |
| `defineSystem` signatures (§ lines 994 **and** 1187) | Unify into the single options-bearing form of §2.1; add `access?: SystemAccess` beside `runIf`; define `SystemAccess`. |
| Example systems that write (§ lines 823 `Movement`, 2625 `SnapToGrid`, 2640 `GestureRecognition`, 2670 `DragSystem`, and the worked example §18) | Add `access: { write: [...] }` to a **representative** couple (e.g. `Movement`, and the §18 multi-system pipeline where diagnostics would realistically fire), with a one-line note that the convention applies to all writing systems under reactivity. Do **not** mechanically annotate all ~8 example systems — that adds noise disproportionate to the point. |
| §17 (§ line 2530, "Cross-cutting concerns") | Add that `access` is the declaration a future parallel scheduler consumes to build the read/write conflict graph and run non-conflicting systems concurrently. The baseline already anticipates parallel per-worker command buffers here (§5.4 note + §17); `access` is the missing input that makes worker-level *system* scheduling possible. This is where "the reason you'd eventually want this" lives. |
| §5.4 (command buffer) | One-line note: change-detection-for-*structure* rides on the flush (which already knows which archetypes migrated), not on `access` — connecting the buffer to the future reactive layer without coupling them. |
| §0 (timing table / overview) | **No change.** `access` alters no timing rule (value writes stay immediate, structure stays deferred). §0 is the normative timing contract; `access` is metadata, not a timing rule. Keeping it out of §0 is correct. |

---

## 5. Non-goals and boundaries (explicit, so scope creep is visible)

- **Not structural changes.** `access` is value read/write only. Spawn/despawn/add/remove/relation stay in the command buffer, flushed at phase boundaries (§5.4). Per the mature-ECS convergence (Bevy `Commands`, DOTS `EntityCommandBuffer`, flecs `defer` all keep structural changes *out* of the access graph), structural changes never enter `access`. Change detection for structure rides on the flush, not here. This is what dissolves the "conditional shape change" soundness problem: the static graph never reasons about archetype topology — the flush handles it dynamically.
- **Not reordering, not scheduling, in v1.** Execution order stays positional (§7.1). `access` is execution-inert except for stamping. Real scheduling is deferred to §17's future parallel work, for which `access` is the declared input.
- **Not resources (v1).** A system's resource read/write is a real access and *would* matter to a future scheduler, but resources are not columns, so their change detection is a distinct, simpler mechanism (one version counter per resource). v1 `access` lists components only; a `readResource`/`writeResource` extension is noted as future work, kept out of the first version to stay tight.
- **Not tags/relations.** Membership filters, not value columns; their changes are structural (buffer-carried).
- **Not a new timing rule.** §0 is unchanged.

---

## 6. Open decisions carried to Patch Note 002 (reactivity)

These are *reactivity* decisions that depend on this note but are not settled here:
1. **Blanket-stamp vs. lazy-stamp default** for §3.1 — stamp all `access.write` after a system runs (zero-per-write, slightly over-fires) vs. an opt-in write-accessor that stamps on actual first write (precise, one branch per written-column-per-frame). Deferred to 002.
2. The observer tiers (query / entity / value), the membership-version for query-level observers, and the `useSyncExternalStore` React binding — all 002.

---

## 7. Summary

Part A adds one optional field, `access`, to system definition. It is a single, dev-enforced-honest source of truth for the component columns a system reads and writes; it is the envelope (union over conditions), covers value read/write only, and is tied-to-the-feature (free until reactivity is on). In v1 it reorders nothing — it feeds change detection (the reason it exists), dev-mode honesty checks, and advisory diagnostics — and it is the exact declaration a future §17 scheduler would consume. It changes no timing rule and breaks no baseline promise: array-order-is-execution-order and pay-for-what-you-use both hold.
