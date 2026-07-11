/**
 * Systems, the system context, and the schedule (design §7).
 *
 * A system pairs a query with a body run once per matching chunk. Inside a system, `ctx`'s
 * shape-change methods DEFER (they enqueue a `StructuralCommand` into the phase's command
 * buffer, applied at the phase boundary), while reads and value writes are immediate — the
 * §5.2 identity-immediate / placement-deferred rule, located on the `ctx` surface.
 */

import type { Entity } from "./entity";
import {
  type Component,
  type ComponentId,
  type Relation,
  type Resource,
  type SpawnInitOf,
  type Tag,
  encodeComponentValue,
} from "./schema";
import type { FieldInput } from "./field";
import type { Batch, Query } from "./query";
import type { CommandBuffer } from "./command";
import type { RuntimeStore } from "./runtime-store";

/** The immediate whole-component value-write surface (§Part I ref). */
export interface EntityEditor {
  set<S>(c: Component<S>, v: S): EntityEditor;
}

/** @internal An immediate whole-component editor bound to `e`, shared by World and SystemCtx. */
export function makeEditor(store: RuntimeStore, e: Entity): EntityEditor {
  const editor: EntityEditor = {
    set(c, v) {
      store.writeComponent(e, c, v);
      return editor;
    },
  };
  return editor;
}

/**
 * World access inside a system. Reads and `edit().set` value writes are immediate; every
 * shape change is deferred to the next phase boundary (§5.2).
 */
export class SystemCtx {
  constructor(
    private readonly store: RuntimeStore,
    private readonly buf: CommandBuffer,
  ) {}

  // --- reads (immediate) ---
  read<S>(e: Entity, c: Component<S>): S {
    return this.store.read(e, c);
  }
  get<S>(e: Entity, c: Component<S>): S | undefined {
    return this.store.get(e, c);
  }
  readField<S, K extends keyof S & string>(e: Entity, c: Component<S>, field: K): S[K] | undefined {
    return this.store.readField(e, c, field);
  }
  has(e: Entity, c: Component): boolean {
    return this.store.has(e, c);
  }
  hasTag(e: Entity, t: Tag): boolean {
    return this.store.hasTag(e, t);
  }
  getRelation(e: Entity, r: Relation): Entity | undefined {
    return this.store.getRelation(e, r);
  }
  getRelations(e: Entity, r: Relation): Entity[] {
    return this.store.getRelations(e, r);
  }
  getReverse(e: Entity, r: Relation): Entity[] {
    return this.store.getReverse(e, r);
  }
  firstOf(q: Query): Entity | undefined {
    return this.store.firstOf(q);
  }
  getResource<S>(res: Resource<S>): S | undefined {
    return this.store.getResource(res);
  }
  isAlive(e: Entity): boolean {
    return this.store.isAlive(e);
  }

  // --- value writes (immediate) ---
  edit(e: Entity): EntityEditor {
    return makeEditor(this.store, e);
  }

  // --- shape changes (deferred to the phase boundary) ---
  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity {
    // Validate BEFORE minting identity or enqueueing: a schema error (missing field, bad enum
    // label) must throw at THIS call site (§4), never at flush where it would strand the rest of
    // the buffer (§5.5). Validating first also avoids leaking an allocated identity on error.
    let components: { component: ComponentId; value: unknown }[] | undefined;
    if (init?.components !== undefined) {
      const seen = new Set<ComponentId>();
      components = [];
      for (const [c, v] of init.components) {
        if (seen.has(c.id)) throw new Error(`strata: component "${c.name}" supplied twice to spawn.`);
        encodeComponentValue(c, v as Record<string, unknown>); // throws here on a schema error
        seen.add(c.id);
        components.push({ component: c.id, value: v });
      }
    }
    const e = this.store.allocateIdentity(); // identity eager, placement deferred (§5.2)
    this.store.enqueue(this.buf, {
      kind: "spawn",
      entity: e,
      components,
      tags: init?.tags?.map((t) => t.id),
    });
    return e;
  }

  destroy(e: Entity): void {
    this.store.enqueue(this.buf, { kind: "despawn", entity: e });
  }

  addComponent<S>(e: Entity, c: Component<S>, value: S): void {
    // Catch the single-system mistake at the call site; the cross-system case is a flush-time
    // policy (§5.5). Only meaningful for a placed entity — a ctx.spawn handle is identity-only.
    if (this.store.isPlaced(e) && this.store.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is already present — use edit().set to overwrite its value.`);
    }
    encodeComponentValue(c, value as Record<string, unknown>); // validate at the call site (§4), not at flush (§5.5)
    this.store.enqueue(this.buf, { kind: "addComponent", entity: e, component: c.id, value });
  }

  removeComponent(e: Entity, c: Component): void {
    if (this.store.isPlaced(e) && !this.store.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present — cannot remove it.`);
    }
    this.store.enqueue(this.buf, { kind: "removeComponent", entity: e, component: c.id });
  }

  addTag(e: Entity, t: Tag): void {
    this.store.enqueue(this.buf, { kind: "addTag", entity: e, tag: t.id });
  }
  removeTag(e: Entity, t: Tag): void {
    this.store.enqueue(this.buf, { kind: "removeTag", entity: e, tag: t.id });
  }

  setRelation(e: Entity, r: Relation, target: Entity): void {
    if (r.arity !== "one") throw new Error(`strata: setRelation is for arity "one" — use addRelation for "${r.name}".`);
    this.store.enqueue(this.buf, { kind: "setRelation", entity: e, relation: r.id, target });
  }
  addRelation(e: Entity, r: Relation, target: Entity): void {
    if (r.arity !== "many") throw new Error(`strata: addRelation is for arity "many" — use setRelation for "${r.name}".`);
    this.store.enqueue(this.buf, { kind: "addRelation", entity: e, relation: r.id, target });
  }
  removeRelation(e: Entity, r: Relation, target?: Entity): void {
    this.store.enqueue(this.buf, { kind: "removeRelation", entity: e, relation: r.id, target });
  }
}

// --- the schedule ------------------------------------------------------------

/** A pure gate on non-query state (a resource flag, a mode, a timer) for a system or phase (§7). */
export type Condition = (ctx: SystemCtx) => boolean;

/** A system body — the per-chunk callback (§6.2). */
export type SystemBody = (batch: Batch, ctx: SystemCtx) => void;

/**
 * A system's value read/write access declaration (Patch Note 001 §2.1). The **envelope** — a union
 * over all conditions, an upper bound on the columns the body may touch on any frame (001 Rule 1),
 * value read/write only (never structural, §5.4). Optional in the base runtime; becomes dev-enforced
 * for writers once reactivity is active (001 §2.4). Components only in v1 — tags/relations are
 * membership filters and resources are a deferred extension (001 §5).
 */
export interface SystemAccess {
  /** Component columns this system may MUTATE (value writes). Union over all conditions (001 Rule 1). */
  readonly write?: readonly Component[];
  /**
   * Component columns treated as READ-ONLY. When omitted, defaults to the query's components that are
   * not in `write` — a system reads what it queries unless declared otherwise (001 §2.3). That default
   * is **not materialized here**; consumers derive it via `effectiveRead` (access-diagnostics.ts), so
   * the stored declaration stays the author's literal input.
   */
  readonly read?: readonly Component[];
  /**
   * Co-located-writer attestation for the same-phase writer-pair advisory (001 §3.3 advisory (a);
   * petition 3a; 001 §3.3 as-built amendment). Naming a column here certifies that THIS system's
   * writes to it are order-tolerant with respect to same-phase co-writers — row-disjoint by
   * construction, commutative, or last-write-wins-safe. Every column listed MUST also appear in
   * `write` (DEV-checked by the pipeline walker; an attestation of an unwritten column is inert).
   * The advisory for a column is suppressed only when EVERY same-phase writer of it attests — so an
   * un-attested newcomer re-fires the warning, and the claim never composes beyond what its
   * co-writers grant. Advisory-only metadata: never feeds `effectiveRead`, never affects runtime
   * access enforcement.
   */
  readonly orderIndependent?: readonly Component[];
}

export interface System {
  /** Display name for tools/instrumentation (observe.ts) — `opts.name`, else the body fn's name. */
  readonly name: string;
  readonly query: Query;
  readonly body: SystemBody;
  readonly runIf?: Condition;
  /** Declared value read/write access (001 §2.1) — the envelope consumed by reactivity + diagnostics. */
  readonly access?: SystemAccess;
}

export interface Phase {
  readonly name: string;
  readonly systems: readonly System[];
  readonly runIf?: Condition;
}

/** A pipeline is a positional array of phases; array order is run order (§7). */
export type Pipeline = readonly Phase[];

/** Pair a query with a body (§7). `opts.name` labels the system; `opts.access` declares its columns (001 §2.1). */
export function defineSystem(
  query: Query,
  body: SystemBody,
  opts?: { runIf?: Condition; name?: string; access?: SystemAccess },
): System {
  return {
    name: opts?.name ?? (body.name || "system"),
    query,
    body,
    runIf: opts?.runIf,
    access: opts?.access,
  };
}

/** Group systems into a named, ordered phase, optionally gated (§7). */
export function phase(name: string, systems: readonly System[], opts?: { runIf?: Condition }): Phase {
  return { name, systems, runIf: opts?.runIf };
}
