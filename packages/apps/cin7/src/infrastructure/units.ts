/**
 * Cin7 reports a product's unit of measure only on the product, not on stock, order or
 * purchase lines. Each connection keeps the units of its catalog in memory and reloads the
 * catalog when a line names a product it doesn't know, at most once per `maxAgeMs`.
 */
export interface ProductUnits {
  /**
   * Returns a lookup for these products, loading the catalog first when one is unknown and the
   * catalog is older than `maxAgeMs`. Products still unknown afterwards have the unit `unknown`.
   */
  resolve(
    ids: Iterable<string>,
    load: () => Promise<Map<string, string>>,
  ): Promise<(id: string) => string>;
  /** Records units read with products, so later reads need no catalog load for them. */
  remember(entries: Iterable<[string, string]>): void;
}

// Unit names Cin7 merchants use for countable items.
const countable = new Set([
  'each',
  'ea',
  'item',
  'items',
  'unit',
  'units',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'stk',
  'stück',
]);

/** Maps a Cin7 unit of measure to Luma's unit; blank units are unknown, never `each`. */
export function unitOf(uom: string | null | undefined) {
  const name = uom?.trim();
  if (!name || name.length > 64) return 'unknown';

  return countable.has(name.toLowerCase()) ? 'each' : name;
}

/** Creates one connection's product unit catalog. */
export function createProductUnits(
  options: { now?: () => number; maxAgeMs?: number } = {},
): ProductUnits {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  let units = new Map<string, string>();
  let loadedAt = -Infinity;
  let loading: Promise<void> | undefined;

  return {
    async resolve(ids, load) {
      const wanted = [...ids];
      if (wanted.some((id) => !units.has(id)) && now() - loadedAt >= maxAgeMs) {
        loading ??= load()
          .then((loaded) => {
            units = new Map([...units, ...loaded]);
            loadedAt = now();
          })
          .finally(() => {
            loading = undefined;
          });
        await loading;
      }

      return (id) => units.get(id) ?? 'unknown';
    },
    remember(entries) {
      for (const [id, unit] of entries) units.set(id, unit);
    },
  };
}
