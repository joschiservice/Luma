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
  'orders.quantity.edit',
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
  'returns.refund',
  'returns.restock',
  'returns.exchange.options.read',
  'returns.exchange.quote.read',
  'returns.exchange.proof.read',
  'returns.exchange.price.read',
  'returns.exchange.reservation.read',
  'returns.exchange.request',
  'returns.exchange.process',
  'returns.exchange.cancel',
  'returns.exchange.release',
  'returns.settlement.quote.read',
  'returns.settlement.proof.read',
]);

const installationTarget = z
  .object({ kind: z.string().min(1).max(100) })
  .catchall(z.string().max(4096));

const installationCredentials = z
  .object({ token: z.string().min(1).max(4096) })
  .catchall(z.unknown());

export const storedCredentials = installationCredentials;

const installationInput = z
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

export const installationBoundary = {
  input: (value: unknown) => installationInput.parse(value),
  credentials: (value: unknown) => installationCredentials.parse(value),
  permissions: (value: unknown) =>
    z
      .array(installationPermissions)
      .max(installationPermissions.options.length)
      .parse(value),
};
