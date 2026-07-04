/**
 * `Local` — the framework-exported partition-ownership tag (design §15.4/§20, plan-part4 locked decision).
 *
 * The ephemeral store (Part IV) auto-applies `Local` to every entity YOU spawn in your own partition, so
 * a query distinguishes your own ephemeral entities from remote peers' projected ones:
 *
 * ```ts
 * import { Local, Not } from "strata-ecs";
 * const remoteCursors = defineQuery([CursorPos, Not(Local)]); // everyone but me
 * ```
 *
 * Three rules make it work, all enforced elsewhere (this module only mints the handle):
 *  - **Query-only for apps.** Read it (`Local` / `Not(Local)`); never `addTag`/`removeTag` it yourself.
 *    The store owns it as the marker of partition ownership — manually adding it to a projected remote
 *    entity, or removing it from your own, desynchronizes the tag from the actual partition and silently
 *    corrupts every `Local`/`Not(Local)` query.
 *  - **Never transmitted.** `Local` is applied LOCALLY by each store to that runtime's own partition; it
 *    is never part of the value blob a peer sends (the ephemeral blob codec excludes it). Each peer
 *    computes it independently from partition ownership — shipping it would mark peer A's entities as
 *    `Local` on peer B too, so B's `Not(Local)` would wrongly exclude the remote peers it means to select.
 *  - **Store-owned lifecycle.** Applied on spawn, cleared on despawn, by the ephemeral store — the only
 *    lifecycle it has.
 *
 * `Local` is a FRAMEWORK tag, not a user-defined one: its name is reserved (schema.ts `FRAMEWORK_RESERVED`)
 * so `defineTag("Local")` throws; the framework mints the handle via {@link defineFrameworkTag}. Import it;
 * do not define it.
 */

import { defineFrameworkTag } from "./schema";
import type { Tag } from "./schema";

/** The ephemeral store's partition-ownership marker (design §15.4). Query-only; never transmitted. */
export const Local: Tag = defineFrameworkTag("Local");
