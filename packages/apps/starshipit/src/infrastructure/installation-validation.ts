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

/**
 * Bearer secret for refresh wakeups: at least 32 printable characters that are not a repeated
 * pattern. Luma generates 32 random bytes on request; programmatic installs such as the pilot
 * may supply their own that meets the same bar.
 */
const webhookSecret = key.min(32).refine((value) => new Set(value).size >= 10);

/**
 * Supplied and stored credentials. A connection without a webhook secret reads normally and
 * refuses wakeups until someone generates one.
 */
export const installationCredentials = z
  .object({
    token: key,
    subscriptionKey: key,
    webhookSecret: webhookSecret.optional(),
  })
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
