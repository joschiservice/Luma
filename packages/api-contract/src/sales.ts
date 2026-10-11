import { z } from 'zod';

const decimal = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);

export const salesAddressSchema = z
  .object({
    name: z.string().max(200),
    company: z.string().max(200),
    street: z.string().max(300),
    city: z.string().max(200),
    postalCode: z.string().max(40),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

export const salesLineSchema = z
  .object({
    id: z.string().uuid(),
    skuId: z.string().uuid().nullable(),
    skuCode: z.string().nullable(),
    title: z.string().nullable(),
    quantity: decimal.refine((v) => Number(v) > 0),
    currentQuantity: decimal,
    unit: z.string().min(1).max(64),
    unitPrice: decimal.nullable(),
    taxRate: decimal.nullable(),
  })
  .strict();

export const salesOrderSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  connectionId: z.string().uuid(),
  version: z.number().int().positive(),
  number: z.string().min(1).max(200),
  status: z.enum(['open', 'completed', 'cancelled']),
  paymentStatus: z.enum([
    'pending',
    'authorized',
    'paid',
    'partially_refunded',
    'refunded',
    'failed',
    'unknown',
  ]),
  customerId: z.string().uuid().nullable(),
  billingAddress: salesAddressSchema.nullable(),
  shippingAddress: salesAddressSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  channel: z.string(),
  total: decimal.nullable(),
  placedAt: z.string().datetime({ offset: true }).nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  lines: z.array(salesLineSchema).max(1000),
});

export const salesEditSchema = z
  .object({
    commandId: z.string().uuid(),
    version: z.number().int().positive(),
    status: z.enum(['open', 'completed', 'cancelled']).optional(),
    billingAddress: salesAddressSchema.nullable().optional(),
    shippingAddress: salesAddressSchema.nullable().optional(),
    lines: z
      .array(
        z.object({ id: z.string().uuid(), currentQuantity: decimal }).strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict();

export type SalesOrder = z.infer<typeof salesOrderSchema>;

export type SalesEdit = z.infer<typeof salesEditSchema>;

export type SalesAddress = z.infer<typeof salesAddressSchema>;
