import { z } from 'zod';

export const installationPermissions = z.enum([
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
  'fulfillment.hold.release',
  'fulfillment.open',
  'fulfillment.move',
  'orders.shipping-method.read',
  'orders.shipping-method.write',
]);

export const installationTarget = z
  .object({ kind: z.string().min(1).max(100) })
  .catchall(z.string().max(4096));

export const installationCredentials = z
  .object({ token: z.string().min(1).max(4096) })
  .catchall(z.unknown());

export const storedCredentials = installationCredentials;

export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    permissions: z
      .array(installationPermissions)
      .min(1)
      .max(9)
      .refine((v) => new Set(v).size === v.length),
    credentials: installationCredentials,
  })
  .strict();

export const installationBoundary = {
  input: (value: unknown) => installationInput.parse(value),
  credentials: (value: unknown) => installationCredentials.parse(value),
  permissions: (value: unknown) =>
    z.array(installationPermissions).max(9).parse(value),
};
