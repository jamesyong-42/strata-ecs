/**
 * The 001 Rule-3 access-enforcement MATRIX (review-part1 R7) — a table pinning today's behavior for
 * every meaningful combination of:
 *
 *   accessor route  × declared/undeclared × armed/disarmed × in-system/outside-tick
 *
 * The enforcement is deliberately NARROW (runtime-store.ts `enforceColAccess`/`enforceWriteAccess`):
 * it fires ONLY when the reactive layer has ARMED it (an observer registered → `armAccessEnforcement`)
 * AND the access happens INSIDE a system during `tick()` (`currentSystem !== null`, set by
 * `beginSystemAccess`) AND the route is a value accessor — `batch.col` (checks write ∪ effectiveRead)
 * or `edit().set` (checks write only). Every other cell ALLOWS:
 *
 *   - DISARMED: no observer ever registered → the `!accessArmed` short-circuit → nothing is checked.
 *   - OUTSIDE A TICK: `world.query().each` / direct `world.*` run with `currentSystem === null`, the
 *     out-of-tick exemption — so a col()/edit().set from a post-tick render walk is never checked.
 *   - THE READ PATH (`read`/`get`/`readField`) is a DELIBERATE EXEMPTION — no access check at all, at
 *     any armed/in-system combination. This matrix pins that as INTENDED, not an oversight (R7): the
 *     001 envelope governs writes + the `col()` bulk handle; scalar reads by handle are always free.
 *   - STRUCTURAL ops (`addComponent`, `addTag`) are never in the value envelope (001 §5), so they are
 *     never access-checked — "declared" is not even a meaningful axis for them.
 *
 * Impossible / nonsensical cells, per the R7 note, are simply absent rather than tested: "declared"
 * has no meaning for the read-path or structural routes (marked n/a below), and `batch.col` outside a
 * system is exercised through its only real door — `world.query(q).each` (the `out` cells for col).
 */

import { describe, expect, it } from "vitest";
import {
  type Batch,
  type Component,
  type Entity,
  type SystemCtx,
  type World,
  createWorld,
  defineComponent,
  defineQuery,
  defineSystem,
  defineTag,
  phase,
} from "./index";

// Process-global schema (EMx-prefixed to stay unique). Every value component is single-field `{ v }`.
const BASE = defineComponent("EMBase", { v: "i32" }); // the system's query component — read-declared by default
const DECL = defineComponent("EMDecl", { v: "i32" }); // in access.write
const UNDECL = defineComponent("EMUndecl", { v: "i32" }); // in neither write nor read
const ADDABLE = defineComponent("EMAddable", { v: "i32" }); // absent on the entity — for addComponent
const TAGX = defineTag("EMTagX");

// Typed with the concrete single-field schema so `readField(e, c, "v")` keys against `"v"` (a bare
// `Component<unknown>` would make `keyof S` = never and reject the field name at compile time).
const COMP: Record<string, Component<{ v: number }>> = { BASE, DECL, UNDECL, ADDABLE };
const qBase = defineQuery([BASE]);
const V = { v: 1 };

type Route = "col" | "editSet" | "read" | "get" | "readField" | "addComponent" | "addTag";
type Loc = "in" | "out";

/** Run `route` against `targetKey` from INSIDE a system body (batch + ctx in scope). */
function inSystem(route: Route, batch: Batch, ctx: SystemCtx, e: Entity, targetKey: string): void {
  const c = COMP[targetKey];
  switch (route) {
    case "col":
      batch.col(c);
      return;
    case "editSet":
      ctx.edit(e).set(c, V);
      return;
    case "read":
      ctx.read(e, c);
      return;
    case "get":
      ctx.get(e, c);
      return;
    case "readField":
      ctx.readField(e, c, "v");
      return;
    case "addComponent":
      ctx.addComponent(e, c, V);
      return;
    case "addTag":
      ctx.addTag(e, TAGX);
      return;
  }
}

/** Run `route` against `targetKey` from OUTSIDE any tick (direct world.* / world.query().each). */
function outside(route: Route, world: World, e: Entity, targetKey: string): void {
  const c = COMP[targetKey];
  switch (route) {
    case "col":
      world.query(qBase).each((b) => {
        b.col(c);
      });
      return;
    case "editSet":
      world.edit(e).set(c, V);
      return;
    case "read":
      world.read(e, c);
      return;
    case "get":
      world.get(e, c);
      return;
    case "readField":
      world.readField(e, c, "v");
      return;
    case "addComponent":
      world.addComponent(e, c, V);
      return;
    case "addTag":
      world.addTag(e, TAGX);
      return;
  }
}

/** The exact throw each enforced route raises when it trips (naming the route + 001 Rule 3). */
const THROW_PATTERN: Partial<Record<Route, RegExp>> = {
  col: /via col\(\) but did not declare it in access/,
  editSet: /via edit\(\)\.set but did not declare it in access\.write/,
};

interface Cell {
  route: Route;
  target: string; // key into COMP, or "TAGX"/"—" where target is implicit / n/a
  loc: Loc;
  armed: boolean;
  outcome: "throw" | "allow";
  note: string; // why this cell has this outcome
}

// Each entity carries BASE, DECL, UNDECL (so the value/read routes never hit "not present"); ADDABLE
// and TAGX are ABSENT so the structural routes are valid adds. A FRESH world per cell keeps the
// deferred in-system addComponent from colliding across cells.
const cells: Cell[] = [
  // --- batch.col (checks write ∪ effectiveRead) ---
  {
    route: "col",
    target: "UNDECL",
    loc: "in",
    armed: true,
    outcome: "throw",
    note: "undeclared col in an armed system throws",
  },
  {
    route: "col",
    target: "UNDECL",
    loc: "in",
    armed: false,
    outcome: "allow",
    note: "disarmed: nothing is checked",
  },
  {
    route: "col",
    target: "UNDECL",
    loc: "out",
    armed: true,
    outcome: "allow",
    note: "out-of-tick col is exempt (currentSystem null)",
  },
  {
    route: "col",
    target: "UNDECL",
    loc: "out",
    armed: false,
    outcome: "allow",
    note: "disarmed + out-of-tick",
  },
  {
    route: "col",
    target: "DECL",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "write-declared col is allowed",
  },
  {
    route: "col",
    target: "BASE",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "read-declared (query default) col is allowed",
  },

  // --- edit().set (checks write only) ---
  {
    route: "editSet",
    target: "UNDECL",
    loc: "in",
    armed: true,
    outcome: "throw",
    note: "undeclared write in an armed system throws",
  },
  {
    route: "editSet",
    target: "UNDECL",
    loc: "in",
    armed: false,
    outcome: "allow",
    note: "disarmed: nothing is checked",
  },
  {
    route: "editSet",
    target: "UNDECL",
    loc: "out",
    armed: true,
    outcome: "allow",
    note: "out-of-tick edit is exempt",
  },
  {
    route: "editSet",
    target: "UNDECL",
    loc: "out",
    armed: false,
    outcome: "allow",
    note: "disarmed + out-of-tick",
  },
  {
    route: "editSet",
    target: "DECL",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "write-declared edit is allowed",
  },
  {
    route: "editSet",
    target: "BASE",
    loc: "in",
    armed: true,
    outcome: "throw",
    note: "read-declared is NOT write-permitted — edit().set still throws",
  },

  // --- the read-path exemption: NEVER checked, even at the harshest cell (undeclared, armed, in-system) ---
  {
    route: "read",
    target: "UNDECL",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "read is exempt from 001 enforcement (intended, R7)",
  },
  {
    route: "get",
    target: "UNDECL",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "get is exempt (intended)",
  },
  {
    route: "readField",
    target: "UNDECL",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "readField is exempt (intended)",
  },
  {
    route: "read",
    target: "UNDECL",
    loc: "out",
    armed: true,
    outcome: "allow",
    note: "read exempt out-of-tick too",
  },

  // --- structural ops: never in the value envelope, so never enforced ("declared" is n/a) ---
  {
    route: "addComponent",
    target: "ADDABLE",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "structural add is never access-checked",
  },
  {
    route: "addComponent",
    target: "ADDABLE",
    loc: "out",
    armed: true,
    outcome: "allow",
    note: "structural add out-of-tick",
  },
  {
    route: "addTag",
    target: "TAGX",
    loc: "in",
    armed: true,
    outcome: "allow",
    note: "structural addTag is never access-checked",
  },
  {
    route: "addTag",
    target: "TAGX",
    loc: "out",
    armed: true,
    outcome: "allow",
    note: "structural addTag out-of-tick",
  },
];

function runCell(cell: Cell): () => void {
  return () => {
    const world = createWorld();
    const e = world.spawn({
      components: [
        [BASE, { v: 0 }],
        [DECL, { v: 0 }],
        [UNDECL, { v: 0 }],
      ],
    });
    // "armed" = a reactive observer has registered (which calls armAccessEnforcement). The observer
    // itself never fires here (we never notify) — it exists only to flip the enforcement switch on.
    if (cell.armed) world.reactive.observeQuery(qBase, [], () => {});

    const act =
      cell.loc === "in"
        ? () => {
            const sys = defineSystem(
              qBase,
              (batch, ctx) => inSystem(cell.route, batch, ctx, e, cell.target),
              {
                access: { write: [DECL] },
              },
            );
            world.tick([phase("p", [sys])]);
          }
        : () => outside(cell.route, world, e, cell.target);

    if (cell.outcome === "throw") {
      expect(act).toThrow(THROW_PATTERN[cell.route]);
    } else {
      expect(act).not.toThrow();
    }
  };
}

describe("001 Rule 3 — access-enforcement matrix (review-part1 R7)", () => {
  for (const cell of cells) {
    const tag = `${cell.armed ? "armed" : "disarmed"} · ${cell.loc === "in" ? "in-system" : "outside-tick"}`;
    it(`${cell.route}(${cell.target}) · ${tag} → ${cell.outcome} — ${cell.note}`, runCell(cell));
  }
});

// A focused companion assertion for the enforced routes: the throw NAMES the offending system and
// component, so the diagnostic is actionable (not just "access denied").
describe("001 Rule 3 — the throw is actionable", () => {
  it("names the system and component for an undeclared col()", () => {
    const world = createWorld();
    const e = world.spawn({
      components: [
        [BASE, { v: 0 }],
        [UNDECL, { v: 0 }],
      ],
    });
    world.reactive.observeQuery(qBase, [], () => {});
    const sys = defineSystem(qBase, (batch) => batch.col(UNDECL), {
      name: "Painter",
      access: { write: [] },
    });
    expect(() => world.tick([phase("p", [sys])])).toThrow(
      /system "Painter".*component "EMUndecl".*col\(\)/s,
    );
    void e;
  });

  it("names the system and component for an undeclared edit().set", () => {
    const world = createWorld();
    const e = world.spawn({
      components: [
        [BASE, { v: 0 }],
        [UNDECL, { v: 0 }],
      ],
    });
    world.reactive.observeQuery(qBase, [], () => {});
    const sys = defineSystem(qBase, (_batch, ctx) => ctx.edit(e).set(UNDECL, { v: 9 }), {
      name: "Mover",
      access: { write: [] },
    });
    expect(() => world.tick([phase("p", [sys])])).toThrow(
      /system "Mover".*component "EMUndecl".*edit\(\)\.set/s,
    );
  });
});
