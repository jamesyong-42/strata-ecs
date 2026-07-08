/**
 * A grow-only interning registry — the "symbol registry" primitive (design §3.4).
 *
 * Maps identifier strings (schema type names, enum variant labels, …) to dense integer ids
 * so runtime identity/equality is a `number ===` comparison. Grow-only by design: the set is
 * finite (bounded by the schema) and nothing ever needs reclaiming.
 *
 * This is the general mechanism. Which id-spaces exist (one shared vs. dense per-kind for
 * compact archetype bitmasks) is decided by the schema layer that instantiates registries;
 * this class only provides interning, resolution, uniqueness, and framework-name reservation.
 */
export class Registry {
  private readonly names: string[] = [];
  private readonly ids = new Map<string, number>();
  private readonly reserved = new Set<string>();

  /**
   * Reserve a framework-owned name (e.g. the ephemeral store's `Local` tag) and assign it an
   * id so the framework can use it. User schema may not (re)define a reserved name — a later
   * {@link define} of it throws. Idempotent: reserving the same name twice returns its id.
   */
  reserve(name: string): number {
    this.reserved.add(name);
    return this.internUnchecked(name);
  }

  /**
   * Register a user-defined identifier and return its id. Throws if the name is reserved
   * (import-only) or has already been defined — identifiers must be unique (§3.4).
   */
  define(name: string): number {
    if (this.reserved.has(name)) {
      throw new Error(
        `strata: "${name}" is a reserved framework identifier — import it from "@vibecook/strata-ecs" rather than defining it yourself.`,
      );
    }
    if (this.ids.has(name)) {
      throw new Error(`strata: "${name}" is already defined — identifiers must be unique.`);
    }
    return this.internUnchecked(name);
  }

  /** Return an existing id or assign a new one. Does not enforce reservation or uniqueness. */
  private internUnchecked(name: string): number {
    const existing = this.ids.get(name);
    if (existing !== undefined) return existing;
    const id = this.names.length;
    this.names.push(name);
    this.ids.set(name, id);
    return id;
  }

  /** The id for a name, or `undefined` if it has not been registered. */
  idOf(name: string): number | undefined {
    return this.ids.get(name);
  }

  /** The name for an id, or `undefined` if the id was never assigned. */
  resolve(id: number): string | undefined {
    return this.names[id];
  }

  /** Whether a name has been registered (reserved or defined). */
  has(name: string): boolean {
    return this.ids.has(name);
  }

  /** Whether a name is reserved for the framework. */
  isReserved(name: string): boolean {
    return this.reserved.has(name);
  }

  /** Number of registered identifiers. */
  get size(): number {
    return this.names.length;
  }
}
