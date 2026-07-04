# Plan — WebSocket Transport Demo + the Tier-2 Cleanup Pass

**Status: IMPLEMENTED** (2026-07-04; Stream B: 3fd7183 dedup + 37eb40f fast path [idle notify() ~997µs → ~37ns at 10k watches] + 675db0f test hardening; Stream A: 574fa3a WS transport [smoke PASS 45/45 over live sockets, reconnect re-bootstrap] + 5199e19 review-lite hardening; lite review verdict: both streams sound; 662 ci + 5 smoke + 240 stress green).

Two independent streams (disjoint file sets; run in parallel).

## Stream A — the real WebSocket transport demo

**Goal:** the collab demo works across MACHINES, not just tabs — a real `ws://` relay + a second
transport implementation behind the same envelope interface D0 defined. The framework is
untouched; this demonstrates the transport seam is real (006's constraints are the contract).

- **The relay** — new workspace member `examples/collab-server/`: a ~100-line Node `ws` server.
  Rooms by name; **dumb byte relay** (broadcasts each envelope to the other room members, never
  inspects contents, holds no document state — peers bootstrap each other via the existing
  hello→snapshot protocol). Per-connection ordering is what WS gives natively, which satisfies
  006's per-peer causal in-order constraint while connected.
- **The client transport** — `collab/transport-ws.ts` implementing the SAME envelope surface as
  the BroadcastChannel module (D0's `wireCollab` shape): binary framing chosen by the
  implementer (documented), `?collab=<room>&ws=<url>` (default `ws://localhost:8787`) selects it;
  no `ws` param = BroadcastChannel as today.
- **Reconnect policy (the 006-mandated part):** a dropped socket = potentially dropped
  increments = quarantine risk on both sides. Demo policy, documented as THE pattern: on
  reconnect, run the full bidirectional bootstrap again (hello + own snapshot; buffer inbound
  until re-bootstrapped). Ephemeral needs nothing (TTL + keepalive already handle absence).
  `PendingImportError` anywhere still surfaces in the HUD — with re-bootstrap it should be
  unreachable.
- **Acceptance:** the SAME `?script=collab-smoke` suite runs over the real socket —
  `&transport=ws` mode drives both in-page worlds through the live relay (started as a
  background process during verification) instead of the loopback shim; PASS parity with the
  loopback modes. Plus: a kill-the-relay/reconnect scenario (drop mid-edit, reconnect,
  re-bootstrap, converge). Headless screenshot; README section (how to run the server, LAN use).

## Stream B — the Tier-2 cleanup (docs/review-part1.md is the source; scope is EXACTLY the open checklist)

1. **Stamp-site dedup (R6, do first — the fast path builds on clean stamp sites):** collapse the
   five hand-copied `applyCommand` tag/relation arms and the `writeComponent`/`projectComponent`
   cell-loop duplication into private stamp-owning primitives (`doAddTag`/`doSetRelation`/
   `doWriteCells`); leave component ops + migrate alone (already single-owner). Add the missing
   flush-path stamp tests (4 of 5 arms were untested).
2. **notify() quiescent fast path (R5):** a per-component max-written-frame array consulted
   before any per-cell work — **it MUST also bump on removal/migrate-away and destroy** (the
   verifier catch: a skip that misses removal notifications is a correctness bug, so the new
   array bumps at every site that can change what a watch would see) — plus allocation-free
   clean paths (no `[...keys]`/`[...m]`/`[...arr]` spreads until a callback actually fires).
   **Bench gate** (the reactiveOn lesson): idle-notify microbench before/after + the migrate-heavy
   suite unchanged (<2%); stamp-site cost stays behind the gate.
3. **Fuzz-oracle reactivity extension (R7):** extend the `__stress__` op alphabet with
   {notify, observeValue, observeQuery, unobserve} + an **armed-from-op-0 variant** (the gate
   means today's fuzz never even executes stamp maintenance); oracle = recompute watched values
   from the reference model, compare against the last-FIRED value with the layer's own equality;
   model death-fires and removal-fires. Tier-1 may over-fire, must never miss.
4. **strata-ecs/tools lifecycle tests (R7):** happy-dom smoke — attach → tick → rows render →
   dispose (interval cleared, BOTH world-observer roster entries detached, DOM removed) →
   re-attach to a second world reflects it.
5. **001 enforcement matrix (R7):** table-driven — accessor route (col / edit().set / read / get
   / readField / structural ops) × declared/undeclared × armed/disarmed × in-system/outside —
   pinning today's behavior including the deliberate read-path exemption.
6. **Cheap adjacents from the same review:** a scaled-down stress smoke inside `ci`
   (`STRESS_SCALE≈0.1`, small numRuns, <30s — the fuzz tier must not rot unrun) and the two
   missing strata-ecs/react tests (StrictMode double-mount; removeComponent-without-death →
   undefined → re-add re-renders).

**Explicitly OUT of scope** (API changes needing their own decision): observeQuery cols
defaulting, `{immediate:true}`, observeEntity deletion, world.count/entities/clone,
updateResource, per-tag stamp arrays. They stay on the review-doc backlog.

**Execution:** Stream A in a worktree (Opus); Stream B sequential in the main tree — B1+B2 (core
source + bench) then B3–B6 (test-only) as separate agents (Opus). Suites green at every commit;
my diff review + a lite review pass over both streams at the end.
