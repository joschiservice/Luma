import type * as s from '@luma/connector-cin7/schemas';
import type { z } from 'zod';

type Sale = z.infer<typeof s.sale>;

/**
 * Recently read sale details of one connection, by sale ID and the update time the sale list
 * reported. Order, fulfillment and return reads list the same sales; a sale whose update time
 * is unchanged needs no second detail request from the shared call budget.
 */
export interface SaleCache {
  get(id: string, updated: string | null | undefined): Sale | undefined;
  set(id: string, updated: string | null | undefined, sale: Sale): void;
}

/** Creates a cache that keeps the most recently stored `limit` sales. */
export function createSaleCache(limit = 2000): SaleCache {
  const entries = new Map<string, { updated: string; sale: Sale }>();

  return {
    get(id, updated) {
      const entry = entries.get(id);

      return updated && entry?.updated === updated ? entry.sale : undefined;
    },
    set(id, updated, sale) {
      if (!updated) return;
      entries.delete(id);
      entries.set(id, { updated, sale });
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}
