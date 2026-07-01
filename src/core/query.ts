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

import type { Entity } from "./entity";
import type { Column } from "./field";
import type { Component, ComponentId, Relation, Tag, TagId } from "./schema";

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

/** A compiled query (store-agnostic). */
export interface Query {
  /** Required components — the archetype must have all (archetype-level AND). */
  readonly required: readonly ComponentId[];
  /** Excluded components — the archetype must have none (`Not(component)`). */
  readonly excluded: readonly ComponentId[];
  /** Each pure-component `Any(...)` — the archetype must have at least one of the group. */
  readonly anyComponentGroups: readonly (readonly ComponentId[])[];
  /** Tag/relation/mixed-`Any` terms, evaluated per row. */
  readonly rowFilters: readonly RowFilter[];
  /** Set when a relation term has a concrete target — flips to reverse-index iteration. */
  readonly seed?: SeedSpec;
}

// --- the batch (chunk) the system body receives ------------------------------

/**
 * The per-archetype chunk handed to a query body (§6.2). Iterate with `for (const r of batch)`
 * to get matching rows (row filters fused); read raw columns via `col`. `denseCount` is the raw
 * archetype row count — the raw `for (r = 0; r < denseCount; r++)` loop is valid ONLY when
 * `isDense` (a dense, unseeded, pure-component chunk).
 */
export interface Batch extends Iterable<number> {
  /** Raw archetype row count. Not a matched-row count (§6.2). */
  readonly denseCount: number;
  /** True only for a dense, unseeded, no-row-filter chunk (the raw loop is valid). */
  readonly isDense: boolean;
  /** Raw columns for a component in this chunk, keyed by field name. */
  col(c: Component): Record<string, Column>;
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

  return { required, excluded, anyComponentGroups, rowFilters, seed };
}
