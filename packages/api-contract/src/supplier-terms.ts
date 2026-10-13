import { z } from 'zod';

const money = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/)
  .max(30);
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().date();

const supplierTermsValuesSchema = z
  .object({
    supplierArticleNumber: z.string().trim().min(1).max(256).nullable(),
    unitPrice: z
      .object({
        amount: money,
        currency: currency.nullable(),
        validFrom: date.nullable(),
      })
      .strict()
      .nullable(),
    packSize: z.number().finite().positive().max(1e9).nullable(),
    lineMinimumQuantity: z.number().finite().nonnegative().max(1e9).nullable(),
    orderMinimumValue: z
      .object({ amount: money, currency })
      .strict()
      .nullable(),
    leadTimeDays: z.number().int().nonnegative().max(3650).nullable(),
    preferred: z.boolean().nullable(),
  })
  .strict();

export const supplierTermsInputSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    skuId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(1000),
    values: supplierTermsValuesSchema
      .partial()
      .refine(
        (values) => Object.keys(values).length > 0,
        'Record at least one term.',
      ),
  })
  .strict();

const supplierTermsVersionSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  skuId: z.string().uuid(),
  revision: z.number().int().positive(),
  source: z.enum(['provider', 'manual', 'import']),
  values: supplierTermsValuesSchema.partial(),
  recordedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  actorId: z.string(),
  reason: z.string(),
  connectionId: z.string().uuid().nullable(),
  sourceRecordId: z.string().nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
  complete: z.boolean(),
});

export const supplierProductTermsSchema = z.object({
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  skuId: z.string().uuid(),
  sku: z.string(),
  revision: z.number().int().positive(),
  lastReadAt: z.string().datetime().optional(),
  lastReadComplete: z.boolean().optional(),
  effective: supplierTermsValuesSchema,
  observed: supplierTermsVersionSchema.nullable(),
  override: supplierTermsVersionSchema.nullable(),
  history: z.array(supplierTermsVersionSchema),
});

export type SupplierProductTerms = z.infer<typeof supplierProductTermsSchema>;

export type SupplierTermsInput = z.input<typeof supplierTermsInputSchema>;
