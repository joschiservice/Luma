import { z } from 'zod';

/**
 * Version of this adapter's normalized output, recorded as observation provenance. Bump it
 * whenever the same provider response would normalize differently.
 */
export const adapterVersion = 'cin7/1';

const timestamp = z.string().datetime({ offset: true });

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z
  .object({ amount: decimal, unit: z.string().min(1) })
  .strict();

const money = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();

const text = z.string().min(1).max(512).nullable();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const observation = <T extends z.ZodTypeAny>(resource: string, data: T) =>
  z
    .object({
      id: z.string().uuid(),
      source: externalId.extend({
        tenantId: z.string().min(1),
        connectionId: z.string().min(1),
        provider: z.literal('cin7'),
        resource: z.literal(resource),
      }),
      kind: z.enum(['snapshot', 'tombstone']),
      observedAt: timestamp,
      sourceUpdatedAt: timestamp.nullable(),
      sourceRevision: z.null(),
      adapterVersion: z.literal(adapterVersion),
      schemaVersion: z.literal(1),
      data,
    })
    .strict();

const page = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      total: z.number().int().nonnegative().optional(),
      completeness: z.literal('complete'),
    })
    .strict();

export const outputs = {
  'orders.read': page(
    observation(
      'order',
      z
        .object({
          displayNumber: text,
          externalOrderNumber: text,
          dueAt: timestamp.nullable(),
          placedAt: timestamp.nullable(),
          total: money.nullable(),
          customer: externalId.nullable().optional(),
          status: z.enum(['open', 'completed', 'cancelled']),
          paymentStatus: z.enum(['pending', 'paid', 'unknown']),
          lines: z.array(
            z
              .object({
                id: externalId,
                sku: externalId,
                quantity,
                cancelledQuantity: z.null(),
                skuCode: text,
                title: text,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'fulfillment.read': page(
    observation(
      'fulfillment',
      z
        .object({
          order: externalId,
          status: z.enum(['pending', 'processing', 'shipped', 'cancelled']),
          lines: z.array(
            z.object({ orderLine: externalId, quantity }).strict(),
          ),
          lastProgressAt: timestamp.nullable(),
          progressBasis: z.literal('source_updated'),
          failureCode: z.null(),
          location: z
            .object({ id: externalId, name: text })
            .strict()
            .nullable(),
          fulfillBy: timestamp.nullable(),
          tracking: z.array(
            z
              .object({
                carrier: text,
                number: text,
                url: z.string().url().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'returns.read': page(
    observation(
      'refund',
      z
        .object({
          type: z.literal('refund'),
          order: externalId,
          return: z.null(),
          createdAt: timestamp.nullable(),
          total: money.nullable(),
          lines: z.array(
            z
              .object({
                orderLine: externalId,
                quantity,
                restock: z.enum(['return', 'no_restock']),
                restocked: z.boolean(),
              })
              .strict(),
          ),
          transactions: z.array(
            z
              .object({
                status: z.literal('success'),
                amount: money,
                processedAt: timestamp.nullable(),
                gateway: z.null(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'products.read': page(
    observation(
      'product',
      z
        .object({
          title: text,
          status: z.enum(['active', 'draft', 'archived', 'unknown']),
          vendor: text,
          skus: z.array(
            z
              .object({
                id: externalId,
                code: text,
                unit: z.string().min(1),
                title: z.null(),
                price: z
                  .object({ amount: decimal, currency: z.null() })
                  .strict()
                  .nullable(),
                barcode: text,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
  'inventory.read': page(
    observation(
      'sku',
      z
        .object({
          sku: externalId,
          location: externalId,
          unit: z.string().min(1),
          onHand: decimal.nullable(),
          reserved: decimal.nullable(),
          available: decimal.nullable(),
          availabilityBasis: z.enum(['provider_reported', 'unknown']),
        })
        .strict(),
    ),
  ),
  'customers.read': page(
    observation(
      'customer',
      z
        .object({
          displayName: text,
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
          createdAt: z.null(),
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
  'suppliers.read': page(
    observation(
      'supplier',
      z
        .object({
          name: text,
          number: z.null(),
          active: z.boolean(),
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
          lumaOrderId: z.null(),
          status: z.enum([
            'open',
            'released',
            'partially_delivered',
            'completed',
            'unknown',
          ]),
          requestedDeliveryDate: date.nullable(),
          confirmed: z.null(),
          createdAt: timestamp.nullable(),
          lines: z.array(
            z
              .object({
                id: externalId,
                sku: externalId,
                itemNumber: text,
                quantity,
                deliveredQuantity: decimal,
                confirmedQuantity: z.null(),
                confirmedDeliveryDate: z.null(),
                confirmed: z.null(),
                requestedDeliveryDate: date.nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  ),
};

export type Cin7ReadCapability = keyof typeof outputs;
