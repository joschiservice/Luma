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

/** Luma purchase-order IDs as stored in the JTL internal-comment marker. */
export const lumaOrderId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  );

export const purchaseOrderInputs = {
  'suppliers.read': query
    .extend({ supplier: ref.optional() })
    .refine((value) => !(value.supplier && value.cursor)),
  'purchase-orders.read': query
    .extend({
      limit: z.number().int().min(1).max(25),
      order: ref.optional(),
      created: z
        .object({
          lumaOrderId,
          createdSince: z.string().datetime({ offset: true }),
        })
        .strict()
        .optional(),
    })
    .refine(
      (value) =>
        [value.order, value.created, value.cursor].filter(Boolean).length <= 1,
    ),
  'purchase-orders.submit': z
    .object({
      lumaOrderId,
      reference: z.string().trim().min(1).max(1000),
      supplier: ref,
      requestedDeliveryDate: calendarDate,
      lines: z
        .array(
          z
            .object({
              sku: ref,
              // Purchase-order lines carry no unit in ERP 2.2; Luma submits countable items only.
              quantity: z
                .object({
                  amount: z
                    .string()
                    .regex(/^\d{1,9}(\.\d{1,6})?$/)
                    .refine((value) => Number(value) > 0),
                  unit: z.literal('each'),
                })
                .strict(),
            })
            .strict(),
        )
        .min(1)
        .max(100)
        .refine(
          (lines) =>
            new Set(lines.map((line) => line.sku.externalId)).size ===
            lines.length,
        ),
    })
    .strict(),
};
