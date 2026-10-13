import { z } from 'zod';

const ref = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();
const quantity = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);

/** Validates exact group identity without creating a stock-bearing parent line. */
export const orderBundleGroupSchema = z
  .object({
    id: ref,
    title: z.string().min(1).max(512),
    quantity,
    product: ref.nullable(),
    variant: ref.nullable(),
    skuCode: z.string().max(512).nullable(),
  })
  .strict();

/** Keeps source component identity and quantity distinct from its descriptive SKU code. */
export const productBundleSchema = z
  .object({
    variant: ref,
    requiresComponents: z.boolean(),
    components: z
      .array(
        z
          .object({ id: ref, variant: ref, sku: ref.nullable(), quantity })
          .strict(),
      )
      .max(5000)
      .refine(
        (values) =>
          new Set(values.map((value) => JSON.stringify(value.id))).size ===
          values.length,
        'Duplicate component identity',
      )
      .nullable(),
  })
  .strict();
