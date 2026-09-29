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
    search: z
      .object({
        field: z.enum(['name', 'email', 'order']),
        value: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.id
        ? value.id.startsWith(`gid://shopify/${value.kind}/`) &&
          (!value.cursor || value.kind === 'Customer')
        : ['Order', 'Product', 'Customer'].includes(value.kind),
    'Record type must match its ID',
  )
  .refine(
    (value) => !value.search || (value.kind === 'Customer' && !value.id),
    'Search requires a customer list',
  );

export type CustomerSearch = NonNullable<z.infer<typeof recordInput>['search']>;

const link = z.object({
  kind: z.enum(recordKinds),
  id: z.string(),
  label: z.string(),
});

export const recordRow = z.object({
  id: z.string(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  links: z.array(link),
});

export const recordSection = z.object({
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
