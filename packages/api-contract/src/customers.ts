import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

export const customerStateSchema = z.enum([
  'enabled',
  'disabled',
  'invited',
  'declined',
  'unknown',
]);

export const customerSortSchema = z.enum(['created', 'orders', 'name']);

export const customerListItemSchema = z.object({
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
});

export const customerSourceSchema = z.object({
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
    sort: customerSortSchema.default('created'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

export const customerListSchema = z.object({
  items: z.array(customerListItemSchema),
  sources: z.array(customerSourceSchema),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
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

export type CustomerSort = z.infer<typeof customerSortSchema>;

export type CustomerListItem = z.infer<typeof customerListItemSchema>;

export type CustomerSource = z.infer<typeof customerSourceSchema>;

export type CustomerList = z.infer<typeof customerListSchema>;

export type CustomerDetail = z.infer<typeof customerDetailSchema>;
