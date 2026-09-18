import { z } from 'zod';

export const installationPermissions = z.enum([
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
  'orders.shipping-method.read',
  'orders.shipping-method.write',
]);
const header = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/)
  .refine((s) => !!s.trim());
export const installationTarget = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('shopify'),
      shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    })
    .strict(),
  z
    .object({ kind: z.literal('jtl-cloud'), jtlTenantId: z.string().uuid() })
    .strict(),
  z
    .object({
      kind: z.literal('jtl-onprem'),
      baseUrl: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname.endsWith('/')
          );
        }),
      appId: header,
      appVersion: header,
    })
    .strict(),
]);
export const installationCredentials = z
  .object({
    token: header,
    challengeCode: header.refine((s) => s.length <= 30).optional(),
  })
  .strict();
export const installationInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    target: installationTarget,
    permissions: z
      .array(installationPermissions)
      .min(1)
      .max(6)
      .refine((v) => new Set(v).size === v.length),
    credentials: installationCredentials,
  })
  .strict()
  .refine(
    (v) => v.target.kind !== 'jtl-onprem' || !!v.credentials.challengeCode,
  )
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

export const installedConnectionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  label: z.string(),
  target: installationTarget,
  permissions: z.array(installationPermissions),
  granted: z.array(installationPermissions),
  status: z.enum(['pending', 'active', 'degraded', 'disconnected', 'revoked']),
  version: z.number().int().positive(),
  credentialVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InstalledConnection = z.infer<typeof installedConnectionSchema>;
export type InstallationInput = z.infer<typeof installationInput>;
export type InstallationCredentials = z.infer<typeof installationCredentials>;
export type InstallationCapability = z.infer<typeof installationPermissions>;
