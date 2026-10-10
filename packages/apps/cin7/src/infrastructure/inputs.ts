import { guid } from '@luma/connector-cin7/schemas';
import { z } from 'zod';

// Cin7 IDs are account-wide GUIDs, so references have no parent scope.
const ref = z.object({ externalId: guid, scopeKey: z.literal('') }).strict();

const query = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

const since = {
  updatedSince: z.string().datetime({ offset: true }).optional(),
};

export const inputs = {
  'orders.read': query.extend(since),
  'fulfillment.read': query
    .extend({ ...since, order: ref.optional() })
    .refine((value) => !(value.order && value.updatedSince)),
  'returns.read': query
    .extend({ ...since, order: ref.optional() })
    .refine((value) => !(value.order && value.updatedSince)),
  'products.read': query.extend(since),
  'inventory.read': query.extend({
    sku: ref.optional(),
    location: ref.optional(),
  }),
  'customers.read': query.extend(since),
  'suppliers.read': query
    .extend({ ...since, supplier: ref.optional() })
    .refine(
      (value) => !(value.supplier && (value.cursor || value.updatedSince)),
    ),
  'purchase-orders.read': query
    .extend({ limit: z.number().int().min(1).max(25), order: ref.optional() })
    .refine((value) => !(value.order && value.cursor)),
};
