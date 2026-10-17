import { accountId } from '@luma/connector-cin7/schemas';
import { z } from 'zod';

const installationPermissions = z.enum([
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
  'returns.read',
  'customers.read',
  'suppliers.read',
  'purchase-orders.read',
]);

export const installationTarget = z
  .object({ kind: z.literal('cin7-core'), accountId })
  .strict();

/** The API application key; Cin7 treats it like a password. */
export const installationCredentials = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x20-\x7e]+$/)
      .refine((s) => !!s.trim()),
  })
  .strict();

export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    permissions: z
      .array(installationPermissions)
      .min(1)
      .max(installationPermissions.options.length)
      .refine((v) => new Set(v).size === v.length),
    credentials: installationCredentials,
  })
  .strict();
