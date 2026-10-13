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
