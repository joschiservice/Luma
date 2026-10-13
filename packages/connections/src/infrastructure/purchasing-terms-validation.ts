import { z } from 'zod';

const external = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();
const decimal = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/)
  .max(30);
const currency = z.string().regex(/^[A-Z]{3}$/);

/** Purchasing metadata returned alongside a product read; omitted fields remain unavailable. */
export const productPurchasingTermsSchema = z
  .object({
    supplier: external,
    sourceRecordId: z.string().min(1).max(1024),
    complete: z.boolean(),
    supplierArticleNumber: z.string().max(256).nullable(),
    unitPrice: z
      .object({
        amount: decimal,
        currency: currency.nullable(),
        validFrom: z.string().date().nullable(),
      })
      .strict()
      .nullable(),
    packSize: z.number().finite().positive().max(1e9).nullable(),
    lineMinimumQuantity: z.number().finite().nonnegative().max(1e9).nullable(),
    orderMinimumValue: z
      .object({ amount: decimal, currency })
      .strict()
      .nullable(),
    leadTimeDays: z.number().int().nonnegative().max(3650).nullable(),
    preferred: z.boolean().nullable(),
  })
  .strict();
