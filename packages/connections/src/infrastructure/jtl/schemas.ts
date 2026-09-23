import { externalId } from '@luma/connector-jtl/schemas';
import { z } from 'zod';

export * from '@luma/connector-jtl/schemas';

const ref = z
  .object({
    externalId,
    scopeKey: z.literal(''),
  })
  .strict();

const query = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

export const inputs = {
  'orders.read': query,
  'products.read': query,
  'inventory.read': query.extend({
    sku: ref.optional(),
    location: z
      .union([
        ref,
        z
          .object({
            externalId: z.literal('all-warehouses'),
            scopeKey: z.literal(''),
          })
          .strict(),
      ])
      .optional(),
  }),
  'fulfillment.read': query.extend({ order: ref.optional() }),
};
