import { z } from 'zod';

import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionGroupSchema,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';

const timestamp = z.string().datetime({ offset: true });

export const customerStateSchema = z.enum([
  'enabled',
  'disabled',
  'invited',
  'declined',
  'unknown',
]);

export const customerSortSchema = z.enum([
  'created',
  'orders',
  'name',
  'amountSpent',
  'updated',
  'lastOrder',
]);

const customerListItemSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  state: customerStateSchema,
  sourceCreatedAt: timestamp.nullable(),
  orderCount: z.number().int().nonnegative().nullable(),
  amountSpent: z
    .object({ amount: z.string(), currency: z.string() })
    .nullable(),
  tags: z.array(z.string()),
  shared: z.object({ contact: z.boolean(), address: z.boolean() }),
  sourceUpdatedAt: timestamp.nullable(),
  observedAt: timestamp,
  missingSince: timestamp
    .nullable()
    .describe(
      'When a complete read of the source first no longer found this customer; null while the source still has them. Luma removes customers that stay missing for 30 days.',
    ),
  country: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Country of the shared address as the source reports it, upper-cased; null when the source shares no address or reports no country.',
    ),
  lastOrderAt: timestamp
    .nullable()
    .optional()
    .describe(
      'Latest placed date of the imported orders this source attributes to the customer; null when none reports one. Omitted without access to orders.',
    ),
});

const customerSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  appId: z.string().nullable(),
  status: z.string(),
  access: z.enum(['granted', 'not_granted', 'not_requested']),
  records: z.number().int().nonnegative(),
  importing: z.boolean(),
  fullReadAt: timestamp.nullable(),
  lastReadAt: timestamp.nullable(),
  failing: z.boolean(),
});

export const customerQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    state: customerStateSchema.optional(),
    connectionId: z.string().uuid().optional(),
    externalId: z.string().min(1).max(1024).optional(),
    where: collectionWhereParameter.optional(),
    group: collectionGroupParameter.optional(),
    groupKey: collectionGroupKeyParameter.optional(),
    groupLimit: collectionGroupLimitParameter,
    timeZone: collectionTimeZoneParameter,
    sort: z
      .union([customerSortSchema, z.templateLiteral(['custom:', z.uuid()])])
      .default('created')
      .describe(
        '`amountSpent` orders by currency, then amount, so amounts compare only within one currency. `updated` is the source’s last change. `lastOrder` needs access to orders. `custom:<field ID>` sorts by a readable custom customer field that holds one value. Customers without a value come last in both directions.',
      ),
    direction: z.enum(['asc', 'desc']).default('desc'),
    count: z
      .literal('exact')
      .optional()
      .describe('Accepted for every list; customer counts are always exact.'),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

export const customerListSchema = z.object({
  items: z.array(customerListItemSchema),
  sources: z.array(customerSourceSchema),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  groups: z
    .array(collectionGroupSchema)
    .optional()
    .describe(
      'With `group`: each group in display order with its exact count, first rows (whose items are in `items`) and per-currency amounts spent. With `groupKey`: the one group, with this page of its rows. `complete` is false while a source is still importing its customers.',
    ),
  groupsTruncated: z
    .boolean()
    .optional()
    .describe(
      'More than 50 groups match; narrow the conditions to see the rest.',
    ),
  asOf: timestamp,
});

export const customerDetailSchema = z.object({
  item: customerListItemSchema,
  address: z
    .object({
      line1: z.string().nullable(),
      line2: z.string().nullable(),
      city: z.string().nullable(),
      region: z.string().nullable(),
      postalCode: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable(),
  source: customerSourceSchema.nullable(),
  asOf: timestamp,
});

export type CustomerState = z.infer<typeof customerStateSchema>;

export type CustomerListItem = z.infer<typeof customerListItemSchema>;

export type CustomerSource = z.infer<typeof customerSourceSchema>;

export type CustomerList = z.infer<typeof customerListSchema>;

export type CustomerDetail = z.infer<typeof customerDetailSchema>;
