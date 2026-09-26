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
      !v.permissions.includes('orders.shipping-method.write') ||
      v.permissions.includes('orders.shipping-method.read'),
  );
