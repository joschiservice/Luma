import { z } from 'zod';

export const updatePermission = 'starshipit:order_update.run';

export const targetSchema = z
  .object({
    connectionId: z.string().uuid(),
    orderId: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
  })
  .strict();

export const lineSchema = z
  .object({
    lineItemId: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    quantity: z.number().int().min(0).max(999999),
  })
  .strict();

export const previewSchema = targetSchema.extend({
  requestId: z.string().uuid(),
  lines: z
    .array(lineSchema)
    .min(1)
    .max(500)
    .refine((v) => new Set(v.map((line) => line.lineItemId)).size === v.length),
});

export const reference = z.object({ id: z.string().uuid() }).strict();
