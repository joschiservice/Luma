import { gid, timestamp } from '@luma/connector-shopify/schemas';
import { z } from 'zod';

export * from '@luma/connector-shopify/schemas';

/**
 * Version of this adapter's normalized output, recorded as observation provenance. Bump it
 * whenever the same provider response would normalize differently.
 */
export const adapterVersion = 'shopify/2';

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z.object({ amount: decimal, unit: z.literal('each') });

const total = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
  .nullable();

const text = z.string().min(1).max(512).nullable();

const observation = <T extends z.ZodTypeAny>(resource: string, data: T) =>
  z.object({
    id: z.string().uuid(),
    source: externalId.extend({
      tenantId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: z.literal('shopify'),
      resource: z.literal(resource),
    }),
    kind: z.literal('snapshot'),
    observedAt: timestamp,
    sourceUpdatedAt: timestamp.nullable(),
    sourceRevision: z.string().nullable(),
    adapterVersion: z.literal(adapterVersion),
    schemaVersion: z.literal(1),
    data,
  });

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    completeness: z.enum(['complete', 'partial']),
    total: z.number().int().nonnegative().nullable().optional(),
    history: z
      .object({ availableFrom: timestamp, requirement: z.string().nullable() })
      .nullable()
      .optional(),
  });

const optionalText = (max: number) => z.string().min(1).max(max).nullable();

export const outputs = {
  'orders.read': page(
    observation(
      'order',
      z.object({
        displayNumber: z.string().nullable(),
        placedAt: timestamp.nullable(),
        total,
        status: z.enum(['open', 'completed', 'cancelled', 'unknown']),
        paymentStatus: z.enum([
          'pending',
          'authorized',
          'paid',
          'partially_refunded',
          'refunded',
          'failed',
          'unknown',
        ]),
        lines: z.array(
          z.object({
            id: externalId,
            sku: externalId.nullable(),
            quantity,
            cancelledQuantity: quantity.nullable(),
            skuCode: text,
            title: text,
          }),
        ),
      }),
    ),
  ),
  'products.read': page(
    observation(
      'product',
      z.object({
        title: z.string().nullable(),
        status: z.enum(['active', 'draft', 'archived', 'unknown']),
        vendor: z.string().nullable(),
        published: z.boolean(),
        skus: z.array(
          z.object({
            id: externalId,
            code: z.string().nullable(),
            unit: z.literal('each'),
            title: z.string().nullable(),
            price: z
              .object({
                amount: decimal,
                currency: z
                  .string()
                  .regex(/^[A-Z]{3}$/)
                  .nullable(),
              })
              .nullable(),
            barcode: z.string().nullable(),
          }),
        ),
      }),
    ),
  ),
  'inventory.read': page(
    observation(
      'sku',
      z.object({
        sku: externalId,
        location: externalId,
        unit: z.literal('each'),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal.nullable(),
        availabilityBasis: z.enum(['provider_reported', 'unknown']),
      }),
    ),
  ),
  'customers.read': page(
    observation(
      'customer',
      z.object({
        displayName: optionalText(512),
        email: optionalText(320),
        phone: optionalText(100),
        address: z
          .object({
            line1: optionalText(512),
            line2: optionalText(512),
            city: optionalText(256),
            region: optionalText(256),
            postalCode: optionalText(64),
            country: optionalText(128),
          })
          .nullable(),
        state: z.enum([
          'enabled',
          'disabled',
          'invited',
          'declined',
          'unknown',
        ]),
        createdAt: timestamp.nullable(),
        orderCount: z.number().int().nonnegative().nullable(),
        amountSpent: total,
        tags: z.array(z.string().min(1).max(255)).max(250),
        shared: z.object({ contact: z.boolean(), address: z.boolean() }),
      }),
    ),
  ),
  'fulfillment.read': page(
    observation(
      'fulfillment',
      z.object({
        order: externalId,
        status: z.enum([
          'pending',
          'processing',
          'completed',
          'shipped',
          'delivered',
          'cancelled',
          'failed',
          'unknown',
        ]),
        lines: z.array(z.object({ orderLine: externalId, quantity })),
        lastProgressAt: timestamp.nullable(),
        progressBasis: z
          .enum(['note_created_or_package_shipped', 'source_updated'])
          .optional(),
        failureCode: z.string().nullable(),
      }),
    ),
  ),
};

const pageInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

const changedInput = pageInput.extend({ updatedSince: timestamp.optional() });

const scoped = (type: string) =>
  z.object({ externalId: gid(type), scopeKey: z.literal('') }).strict();

export const inputs = {
  'orders.read': changedInput,
  'products.read': changedInput,
  'customers.read': changedInput,
  'inventory.read': pageInput.extend({
    sku: scoped('InventoryItem').optional(),
    location: scoped('Location').optional(),
  }),
  'fulfillment.read': changedInput.extend({
    order: scoped('Order').optional(),
  }),
};

export const customerNode = z.object({
  id: gid('Customer'),
  createdAt: timestamp,
  updatedAt: timestamp,
  state: z.string(),
  numberOfOrders: z.union([
    z
      .string()
      .regex(/^\d{1,15}$/)
      .transform(Number),
    z.number().int().nonnegative(),
  ]),
  amountSpent: z.object({ amount: z.string(), currencyCode: z.string() }),
  tags: z.array(z.string()),
  displayName: z.string().optional(),
  defaultEmailAddress: z
    .object({ emailAddress: z.string().nullable() })
    .nullable()
    .optional(),
  defaultPhoneNumber: z
    .object({ phoneNumber: z.string().nullable() })
    .nullable()
    .optional(),
  defaultAddress: z
    .object({
      address1: z.string().nullable(),
      address2: z.string().nullable(),
      city: z.string().nullable(),
      province: z.string().nullable(),
      zip: z.string().nullable(),
      countryCodeV2: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

export const scanStart = z.object({
  currentAppInstallation: z.object({
    accessScopes: z.array(z.object({ handle: z.string() })),
  }),
  count: z
    .object({
      count: z.number().int().nonnegative(),
      precision: z.enum(['EXACT', 'AT_LEAST']),
    })
    .nullable()
    .optional(),
});
