/**
 * The reified shape change — a `StructuralCommand` (design §5.3).
 *
 * The runtime-internal deferral format: a tagged union over the runtime's shape-change ops, with
 * every entity reference a real `Entity` handle (identity is minted eagerly at `ctx.spawn`, §5.2)
 * and every component/tag/relation reference an interned numeric id (id-keyed, never string-keyed,
 * §3.4). Value writes are deliberately absent — they are the immediate path, never buffered.
 */

import type { Entity } from "./entity";
import type { ComponentId, OrderPlace, RelationId, TagId } from "./schema";

/** Initial components for a spawn — id + raw value object, encoded at flush (§5.3). */
export type ComponentInit = ReadonlyArray<{ readonly component: ComponentId; readonly value: unknown }>;

export type StructuralCommand =
  | { readonly kind: "spawn"; readonly entity: Entity; readonly components?: ComponentInit; readonly tags?: readonly TagId[] }
  | { readonly kind: "despawn"; readonly entity: Entity }
  | { readonly kind: "addComponent"; readonly entity: Entity; readonly component: ComponentId; readonly value: unknown }
  | { readonly kind: "removeComponent"; readonly entity: Entity; readonly component: ComponentId }
  | { readonly kind: "addTag"; readonly entity: Entity; readonly tag: TagId }
  | { readonly kind: "removeTag"; readonly entity: Entity; readonly tag: TagId }
  | { readonly kind: "setRelation"; readonly entity: Entity; readonly relation: RelationId; readonly target: Entity; readonly place?: OrderPlace }
  | { readonly kind: "moveRelation"; readonly entity: Entity; readonly relation: RelationId; readonly place: OrderPlace }
  | { readonly kind: "addRelation"; readonly entity: Entity; readonly relation: RelationId; readonly target: Entity }
  | { readonly kind: "removeRelation"; readonly entity: Entity; readonly relation: RelationId; readonly target?: Entity };

/** An opaque handle to one pooled command buffer (not the storage itself, §5.4). */
export type CommandBuffer = number;
