import { productPurchasingTermsSchema } from '@luma/connections/composition';
import { createCursorCodec } from '@luma/connector-jtl';
import { z } from 'zod';

/**
 * Version of this adapter's normalized output, recorded as observation provenance. Bump it
 * whenever the same provider response would normalize differently.
 */
export const adapterVersion = 'jtl/8';

/** Page cursor for paged JTL reads, bound to the request that produced it. */
export const pageCursor = createCursorCodec(
  z
    .object({
      binding: z.string(),
      page: z.number().int().min(2).max(2147483647),
    })
    .strict(),
);

const timestamp = z.string().datetime({ offset: true });

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z.object({ amount: decimal, unit: z.string().min(1) });

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
      provider: z.literal('jtl'),
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
    total: z.number().int().nonnegative().optional(),
    completeness: z.enum(['complete', 'partial']),
  });

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const option = (kind: 'warehouse' | 'reason') =>
  z.object({ kind: z.literal(kind), name: text }).strict();

export const outputs = {
  'returns.options.read': page(
    z.union([
      observation('location', option('warehouse')),
      observation('return_reason', option('reason')),
    ]),
  ),
  'returns.created.read': page(
    observation(
      'return',
      z
        .object({
          order: externalId,
          number: text,
          lumaCaseId: z.string().min(1).max(128),
          createdAt: timestamp.nullable(),
          warehouse: externalId.nullable(),
          lines: z.array(
            z
              .object({
                orderLine: externalId.nullable(),
                quantity: z
                  .object({ amount: decimal, unit: z.literal('each') })
                  .strict(),
                reason: externalId.nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'suppliers.read': page(
    observation(
      'supplier',
      z
        .object({
          name: text,
          number: text,
          active: z.boolean().nullable(),
          email: z.string().min(3).max(320).nullable(),
        })
        .strict(),
    ),
  ),
  'purchase-orders.read': page(
    observation(
      'purchase_order',
      z
        .object({
          supplier: externalId,
          orderNumber: text,
          lumaOrderId: z.string().min(1).max(128).nullable(),
          status: z.enum([
            'open',
            'released',
            'in_progress',
            'partially_delivered',
            'overdue',
            'completed',
            'unknown',
          ]),
          requestedDeliveryDate: date.nullable(),
          confirmed: z.boolean().nullable(),
          createdAt: timestamp.nullable(),
          lines: z.array(
            z
              .object({
                id: externalId,
                sku: externalId.nullable(),
                itemNumber: text,
                quantity,
                deliveredQuantity: decimal.nullable(),
                confirmedQuantity: decimal.nullable(),
                confirmedDeliveryDate: date.nullable(),
                confirmed: z.boolean().nullable(),
                requestedDeliveryDate: date.nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'orders.read': page(
    observation(
      'order',
      z.object({
        displayNumber: z.string().nullable(),
        externalOrderNumber: z.string().nullable(),
        placedAt: timestamp.nullable(),
        total,
        customer: externalId.nullable().optional(),
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
            unitPrice: total.nullable().optional(),
            taxIncluded: z.boolean().nullable().optional(),
            taxRate: decimal.nullable().optional(),
            skuCode: text,
            title: text,
          }),
        ),
      }),
    ),
  ),
  'customers.read': page(
    observation(
      'customer',
      z
        .object({
          displayName: z.string().min(1).max(512).nullable(),
          email: z.string().min(1).max(320).nullable(),
          phone: z.string().min(1).max(100).nullable(),
          address: z
            .object({
              line1: text,
              line2: text,
              city: z.string().min(1).max(256).nullable(),
              region: z.string().min(1).max(256).nullable(),
              postalCode: z.string().min(1).max(64).nullable(),
              country: z.string().min(1).max(128).nullable(),
            })
            .strict()
            .nullable(),
          state: z.enum(['enabled', 'disabled']),
          createdAt: timestamp.nullable(),
          orderCount: z.null(),
          amountSpent: z.null(),
          tags: z.array(z.string().min(1).max(255)).max(250),
          shared: z
            .object({ contact: z.literal(true), address: z.literal(true) })
            .strict(),
        })
        .strict(),
    ),
  ),
  'products.read': page(
    observation(
      'product',
      z.object({
        title: z.string().nullable(),
        status: z.enum(['active', 'archived']),
        vendor: text,
        published: z.boolean().nullable(),
        skus: z.array(
          z.object({
            id: externalId,
            code: z.string().nullable(),
            unit: z.string().min(1),
            title: z.null(),
            price: z.object({ amount: decimal, currency: z.null() }).nullable(),
            barcode: text,
            purchasingTerms: z
              .array(productPurchasingTermsSchema)
              .max(100)
              .optional(),
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
        unit: z.string().min(1),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal.nullable(),
        availabilityBasis: z.enum(['provider_reported', 'unknown']),
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
        kind: z.literal('shipment'),
        tracking: z.array(
          z.object({
            carrier: z.null(),
            number: z.string().min(1).nullable(),
            url: z.string().url().nullable(),
          }),
        ),
      }),
    ),
  ),
};
