/**
 * The query API — `defineQuery` and its operators (design §6).
 *
 * A query is an array of top-level terms AND-ed together. Compilation sorts terms by *where*
 * they evaluate (§6.1): component terms fold into archetype-level required/excluded/any-groups
 * (checked once per archetype, cached), tag/relation terms become per-row `rowFilters`, and a
 * concrete relation target becomes a `seed` that inverts iteration to start from the reverse
 * index. The compiled {@link Query} is store-agnostic; each store caches its own matching
 * archetypes against it.
 */

import type { ColumnsOf } from "./field";
import type { Entity } from "./entity";
import type { Component, ComponentId, Relation, RelationId, Tag, TagId } from "./schema";

// --- term inputs -------------------------------------------------------------

/** A relation term produced by {@link Related}. */
export interface RelTerm {
  readonly kind: "related";
  readonly relation: Relation;
  readonly target?: Entity;
}

/** An atom is a bare component, a tag, or a relation term. */
export type Atom = Component | Tag | RelTerm;

export interface NotTerm {
  readonly kind: "not";
  readonly term: Atom;
}
export interface AllTerm {
  readonly kind: "all";
  readonly terms: readonly Atom[];
}
export interface AnyTerm {
  readonly kind: "any";
  readonly terms: readonly (Atom | AllTerm)[];
}

/** A top-level query term. */
export type QueryTerm = Atom | NotTerm | AllTerm | AnyTerm;

/** Match entities related via `rel`; omit `target` for "any edge", give one for a specific target (§6.4). */
export function Related(rel: Relation, target?: Entity): RelTerm {
  return { kind: "related", relation: rel, target };
}
/** Exclude entities matching `x` (one atom). To exclude a disjunction, negate each (§6.4). */
export function Not(x: Atom): NotTerm {
  return { kind: "not", term: x };
}
/** Match if ANY member holds — a disjunction within one term (§6.4). */
export function Any(...terms: (Atom | AllTerm)[]): AnyTerm {
  return { kind: "any", terms };
}
/** An explicit conjunction group — useful inside `Any` to express "(A ∧ B) ∨ C" (§6.4). */
export function All(...terms: Atom[]): AllTerm {
  return { kind: "all", terms };
}

// --- compiled plan -----------------------------------------------------------

/** A per-row membership check (a member of an `Any`, or a whole tag/relation term). */
export interface MemberCheck {
  readonly kind: "component" | "tag" | "rel" | "all";
  readonly componentId?: ComponentId;
  readonly tagId?: TagId;
  readonly relation?: Relation;
  readonly target?: Entity;
  readonly members?: readonly MemberCheck[];
}

/** A per-row filter (§6.1): a tag/relation presence test, or a mixed `Any` OR-of-members. */
export interface RowFilter {
  readonly kind: "tag" | "rel" | "any";
  readonly negate: boolean;
  readonly tagId?: TagId;
  readonly relation?: Relation;
  readonly target?: Entity;
  readonly members?: readonly MemberCheck[];
}

/** Concrete-target relation seed — iteration starts from the reverse index (§6.4). */
export interface SeedSpec {
  readonly relation: Relation;
  readonly target: Entity;
}

/**
 * A compiled query (store-agnostic) — **opaque** to consumers. Build one with {@link defineQuery}
 * and hold it as a module constant. The compiled plan (required / excluded / any-groups / row
 * filters / seed) is the store engine's private read view: those fields are stripped from the
 * published types, so an application sees only this opaque handle and cannot depend on, or hand-
 * build, the plan shape (R2 seam).
 *
 * `__brand` is a phantom field (never written at runtime) typed `never`: no value of type `never`
 * exists, so a plain object is not assignable to `Query` — hand-constructing one needs an explicit
 * unsafe cast, and {@link defineQuery} is the sole producer.
 *
 * NOTE: never write the strip-marker JSDoc tag anywhere in THIS comment (even in prose/backticks) —
 * `stripInternal` scans the whole comment for it and would drop the entire interface. Mark the plan
 * FIELDS below individually (as they are) instead; the field markers strip only the fields.
 */
export interface Query {
  /** The opaque brand — phantom, type-level only, never present at runtime. */
  readonly __brand: never;
  /** @internal Required components — the archetype must have all (archetype-level AND). */
  readonly required: readonly ComponentId[];
  /** @internal Excluded components — the archetype must have none (`Not(component)`). */
  readonly excluded: readonly ComponentId[];
  /** @internal Each pure-component `Any(...)` — the archetype must have at least one of the group. */
  readonly anyComponentGroups: readonly (readonly ComponentId[])[];
  /** @internal Tag/relation/mixed-`Any` terms, evaluated per row. */
  readonly rowFilters: readonly RowFilter[];
  /** @internal Set when a relation term has a concrete target — flips to reverse-index iteration. */
  readonly seed?: SeedSpec;
  /**
   * @internal Deduped tag ids this query's membership depends on (002 §4.2 per-id stamps): every tag
   * row filter (negated included) and every tag member of a mixed `Any`. A row-filtered Tier-1
   * observer wakes only when one of THESE tags moved, not on world-wide tag churn.
   */
  readonly membershipTagIds: readonly TagId[];
  /**
   * @internal Deduped relation ids this query's membership depends on (002 §4.2 per-id stamps): every
   * relation row filter (negated and demoted concrete-target included), every relation member of a
   * mixed `Any`, and the concrete-target `seed`'s relation. Component membership is EXCLUDED — a
   * component gain/loss migrates the row, so it rides the archetype's structural stamp, not these.
   */
  readonly membershipRelIds: readonly RelationId[];
}

// --- the batch (chunk) the system body receives ------------------------------

/**
 * The per-archetype chunk handed to a query body (§6.2).
 *
 * Fastest idiom — a raw loop over the materialized matched rows, valid for EVERY chunk kind (dense,
 * row-filtered, seeded), with no generator and no per-row filter re-check:
 *
 * ```ts
 * const px = b.col(Position).x as Float64Array;
 * for (let i = 0; i < b.count; i++) { const r = b.rows[i]; px[r] += 1; }
 * ```
 *
 * `for (const r of batch)` is equivalent (row filters fused) and ergonomic — now backed by `rows`,
 * not a generator. Read columns via `col`. `rows` / the columns / `entity` are valid only inside the
 * current `each` callback (chunk-scoped; the row buffer may be reused for the next chunk).
 */
export interface Batch extends Iterable<number> {
  /** Number of MATCHED rows in this chunk (row filters applied). Loop bound for {@link Batch.rows}. */
  readonly count: number;
  /** Matched row indices; valid for `rows[0 .. count)`. Chunk-scoped (do not retain past `each`). */
  readonly rows: Int32Array;
  /** @internal Raw archetype row count (§6.2) — the `for (r < denseCount)` bound, valid only when `isDense`. */
  readonly denseCount: number;
  /** @internal True only for a dense, unseeded, no-row-filter chunk (the raw `denseCount` loop is valid). */
  readonly isDense: boolean;
  /** Raw columns for a component in this chunk, keyed by field name — typed from the component's
   *  schema literal (`col(Position).x` is a `Float32Array`, no cast). A bare {@link Component}
   *  degrades to the loose `{ [name: string]: Column }`. */
  col<S, Sch>(c: Component<S, Sch>): ColumnsOf<Sch>;
  /** The entity handle at row `r`. */
  entity(r: number): Entity;
  /** A target of `rel` for the entity at row `r` (the first, for a many-relation), validated. */
  getRelated(r: number, rel: Relation): Entity | undefined;
  /** All targets of `rel` for the entity at row `r`, validated. */
  getAllRelated(r: number, rel: Relation): Entity[];
  [Symbol.iterator](): Iterator<number>;
}

// --- compilation -------------------------------------------------------------

function isRelTerm(x: QueryTerm | Atom): x is RelTerm {
  return typeof x === "object" && (x as { kind?: unknown }).kind === "related";
}
function isComponent(x: Atom): x is Component {
  return "fields" in x;
}

function toMemberCheck(atom: Atom | AllTerm): MemberCheck {
  if ("kind" in atom && atom.kind === "all") {
    return { kind: "all", members: atom.terms.map(toMemberCheck) };
  }
  if (isRelTerm(atom)) {
    return { kind: "rel", relation: atom.relation, target: atom.target };
  }
  if (isComponent(atom)) {
    return { kind: "component", componentId: atom.id };
  }
  return { kind: "tag", tagId: atom.id };
}

/** Compile query terms into a cached {@link Query} (§6.1). */
export function defineQuery(terms: readonly QueryTerm[]): Query {
  const required: ComponentId[] = [];
  const excluded: ComponentId[] = [];
  const anyComponentGroups: ComponentId[][] = [];
  const rowFilters: RowFilter[] = [];
  let seed: SeedSpec | undefined;

  const addRel = (rel: RelTerm, negate: boolean): void => {
    if (rel.target !== undefined) {
      if (seed === undefined && !negate) {
        seed = { relation: rel.relation, target: rel.target };
      } else {
        rowFilters.push({ kind: "rel", negate, relation: rel.relation, target: rel.target });
      }
    } else {
      rowFilters.push({ kind: "rel", negate, relation: rel.relation });
    }
  };

  const addNot = (atom: Atom): void => {
    if (isRelTerm(atom)) {
      addRel(atom, true);
    } else if (isComponent(atom)) {
      excluded.push(atom.id);
    } else {
      rowFilters.push({ kind: "tag", negate: true, tagId: atom.id });
    }
  };

  const addAny = (any: AnyTerm): void => {
    const allBareComponents = any.terms.every(
      (t) => !("kind" in t) && isComponent(t as Atom),
    );
    if (allBareComponents) {
      anyComponentGroups.push((any.terms as Component[]).map((c) => c.id));
    } else {
      rowFilters.push({ kind: "any", negate: false, members: any.terms.map(toMemberCheck) });
    }
  };

  const addTop = (term: QueryTerm): void => {
    if ("kind" in term) {
      switch (term.kind) {
        case "related":
          addRel(term, false);
          return;
        case "not":
          addNot(term.term);
          return;
        case "all":
          for (const t of term.terms) addTop(t);
          return; // All at top level = flatten into the AND
        case "any":
          addAny(term);
          return;
      }
    }
    if (isComponent(term as Atom)) {
      required.push((term as Component).id);
    } else {
      rowFilters.push({ kind: "tag", negate: false, tagId: (term as Tag).id });
    }
  };

  for (const term of terms) addTop(term);

  // Extract the per-id membership dependencies (002 §4.2 per-id stamps): the tags/relations whose
  // membership can turn over a row-filtered / seeded query's rows WITHOUT moving an archetype row
  // (so no structural stamp catches them). A component member of a mixed `Any` is skipped — a
  // component gain/loss migrates the row, covered by the archetype's `lastStructuralFrame`.
  const membershipTagIds: TagId[] = [];
  const membershipRelIds: RelationId[] = [];
  const addTagDep = (id: TagId): void => {
    if (!membershipTagIds.includes(id)) membershipTagIds.push(id);
  };
  const addRelDep = (id: RelationId): void => {
    if (!membershipRelIds.includes(id)) membershipRelIds.push(id);
  };
  const walkMember = (m: MemberCheck): void => {
    switch (m.kind) {
      case "tag":
        addTagDep(m.tagId as TagId);
        return;
      case "rel":
        addRelDep((m.relation as Relation).id);
        return;
      case "component":
        return; // component membership rides the archetype's structural stamp, not §4.2
      case "all":
        for (const mm of m.members as readonly MemberCheck[]) walkMember(mm);
        return;
    }
  };
  for (const rf of rowFilters) {
    if (rf.kind === "tag") addTagDep(rf.tagId as TagId);
    else if (rf.kind === "rel") addRelDep((rf.relation as Relation).id);
    else for (const m of rf.members as readonly MemberCheck[]) walkMember(m); // "any"
  }
  if (seed !== undefined) addRelDep(seed.relation.id); // the seed's relation turns over on set/remove

  // The one sanctioned unsafe cast (Query is opaque + `never`-branded): defineQuery is the SOLE
  // producer, so it builds the plan and stamps the phantom brand here. The `satisfies` keeps the
  // plan shape checked; nothing outside this function can construct a Query.
  return { required, excluded, anyComponentGroups, rowFilters, seed, membershipTagIds, membershipRelIds } satisfies Omit<Query, "__brand"> as unknown as Query;
}
