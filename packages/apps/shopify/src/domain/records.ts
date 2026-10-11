import { z } from 'zod';

export const recordKinds = [
  'Order',
  'Customer',
  'Product',
  'ProductVariant',
  'InventoryItem',
  'FulfillmentOrder',
  'Return',
  'Refund',
] as const;

export const recordInput = z
  .object({
    connectionId: z.string().uuid(),
    kind: z.enum(recordKinds),
    id: z
      .string()
      .regex(/^gid:\/\/shopify\/[A-Za-z]+\/[0-9]+$/)
      .optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.id
        ? value.id.startsWith(`gid://shopify/${value.kind}/`) &&
          (!value.cursor || value.kind === 'Customer')
        : ['Order', 'Product'].includes(value.kind),
    'Record type must match its ID',
  );

const link = z.object({
  kind: z.enum(recordKinds),
  id: z.string(),
  label: z.string(),
});

const recordRow = z.object({
  id: z.string(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  fields: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
  links: z.array(link),
});

const recordSection = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum([
    'available',
    'missing_scope',
    'approval_required',
    'access_denied',
    'partial',
  ]),
  requiredScopes: z.array(z.string()),
  message: z.string().nullable(),
  rows: z.array(recordRow),
});

export const recordDetail = z.object({
  tenantId: z.string(),
  connectionId: z.string(),
  shop: z.string(),
  kind: z.enum(recordKinds),
  id: z.string(),
  observedAt: z.string().datetime({ offset: true }),
  apiVersion: z.string(),
  sections: z.array(recordSection),
  nextCursor: z.string().nullable(),
});

export type ShopifyRecordKind = (typeof recordKinds)[number];

export type ShopifyRecordRow = z.infer<typeof recordRow>;

export type ShopifyRecordSection = z.infer<typeof recordSection>;

export type ShopifyRecordDetail = z.infer<typeof recordDetail>;

/** Maps record reads to the installed capability that authorizes their operational context. */
export function recordCapability(kind: ShopifyRecordKind) {
  if (kind === 'Product' || kind === 'ProductVariant') return 'products.read';
  if (kind === 'InventoryItem') return 'inventory.read';
  if (kind === 'FulfillmentOrder') return 'fulfillment.read';

  return 'orders.read';
}

/** The core read permission a person and the Shopify app both need to read a record kind. */
export function recordPermission(kind: ShopifyRecordKind) {
  switch (kind) {
    case 'Order':
      return 'orders.read';
    case 'FulfillmentOrder':
      return 'fulfillment.read';
    case 'Customer':
      return 'customers.read';
    case 'Product':
    case 'ProductVariant':
      return 'products.read';
    case 'InventoryItem':
      return 'inventory.read';
    case 'Return':
    case 'Refund':
      return 'returns.read';
  }
}
