import { z } from 'zod';

export const installationPermissions = z.enum([
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
  'suppliers.read',
  'purchase-orders.read',
  'purchase-orders.submit',
  'messages.read',
  'message-threads.read',
  'message-attachments.read',
  'messages.send',
  'returns.options.read',
  'returns.created.read',
  'returns.create',
]);

const header = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/)
  .refine((s) => !!s.trim());

export const installationTarget = z
  .object({ kind: z.string().min(1).max(100) })
  .catchall(z.string().max(4096));

export const installationCredentials = z
  .object({ token: header })
  .catchall(z.unknown());

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
  .strict();

export const installedConnectionSchema = z.object({
  writeMode: z.literal('observe_only').nullable().optional(),
  provider: z.string().optional(),
  appId: z.string().optional(),
  management: z.array(z.enum(['check', 'rotate'])).optional(),
  appInstallationVersion: z.number().int().positive().optional(),
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
