import { z } from 'zod';

const key = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

export const installationTarget = z
  .object({
    kind: z.literal('starshipit'),
    accountId: z.string().trim().min(1).max(120),
  })
  .strict();

export const installationCredentials = z
  .object({ token: key, subscriptionKey: key, webhookSecret: key.optional() })
  .strict();

export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    credentials: installationCredentials,
    permissions: z
      .array(
        z.enum(['orders.read', 'fulfillment.read', 'orders.quantity.update']),
      )
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length)
      .refine(
        (v) =>
          !v.includes('orders.quantity.update') ||
          (v.includes('orders.read') && v.includes('fulfillment.read')),
      ),
  })
  .strict();
