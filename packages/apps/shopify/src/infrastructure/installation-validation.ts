import { z } from 'zod';

const installationPermissions = z.enum([
  'orders.read',
  'products.read',
  'inventory.read',
  'inventory.available.reconcile',
  'fulfillment.read',
  'fulfillment.hold.release',
  'fulfillment.open',
  'fulfillment.move',
  'customers.read',
  'returns.read',
  'orders.shipping-method.read',
  'orders.shipping-method.write',
]);

const header = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/)
  .refine((s) => !!s.trim());

export const installationTarget = z
  .object({
    kind: z.literal('shopify'),
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  })
  .strict();

export const installationCredentials = z
  .object({
    token: header,
    challengeCode: header.refine((s) => s.length <= 30).optional(),
  })
  .strict();

export const storedCredentials = installationCredentials.extend({
  shopify: z
    .object({
      app: z.string().min(1),
      refreshToken: header,
      expiresAt: z.string().datetime(),
      refreshExpiresAt: z.string().datetime(),
      scopes: z.array(z.string()),
    })
    .strict()
    .optional(),
});

export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    permissions: z
      .array(installationPermissions)
      .min(1)
      .max(16)
      .refine((v) => new Set(v).size === v.length),
    credentials: installationCredentials,
  })
  .strict()

  .refine(
    (v) =>
      v.target.kind !== 'shopify' ||
      !v.permissions.some((p) => p.startsWith('orders.shipping-method.')),
  )
  .refine(
    (v) =>
      !v.permissions.includes('orders.shipping-method.write') ||
      v.permissions.includes('orders.shipping-method.read'),
  );
