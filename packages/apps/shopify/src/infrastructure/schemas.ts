import { count, gid, money, timestamp } from '@luma/connector-shopify/schemas';
import { z } from 'zod';

export * from '@luma/connector-shopify/schemas';

/**
 * Version of this adapter's normalized output, recorded as observation provenance. Bump it
 * whenever the same provider response would normalize differently.
 */
export const adapterVersion = 'shopify/7';

const externalId = z
  .object({ externalId: z.string().min(1), scopeKey: z.string() })
  .strict();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const quantity = z.object({ amount: decimal, unit: z.literal('each') });

const total = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
  .nullable();

const text = z.string().min(1).max(512).nullable();

const observation = <T extends z.ZodTypeAny>(
  resource: string | z.ZodTypeAny,
  data: T,
) =>
  z.object({
    id: z.string().uuid(),
    source: externalId.extend({
      tenantId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: z.literal('shopify'),
      resource: typeof resource === 'string' ? z.literal(resource) : resource,
    }),
    kind: z.enum(['snapshot', 'tombstone']),
    observedAt: timestamp,
    sourceUpdatedAt: timestamp.nullable(),
    sourceRevision: z.string().nullable(),
    adapterVersion: z.literal(adapterVersion),
    schemaVersion: z.literal(1),
    data,
  });

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    confirmation: z
      .enum(['present', 'missing', 'history_limited', 'deleted'])
      .optional(),
    items: z.array(item),
    nextCursor: z.string().nullable(),
    completeness: z.enum(['complete', 'partial']),
    deferred: z.boolean().optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    total: z.number().int().nonnegative().nullable().optional(),
    history: z
      .object({ availableFrom: timestamp, requirement: z.string().nullable() })
      .nullable()
      .optional(),
  });

const optionalText = (max: number) => z.string().min(1).max(max).nullable();

const count6 = decimal.refine((value) => !value.startsWith('-'));

const returnData = z.object({
  type: z.literal('return'),
  order: externalId,
  name: text,
  status: z.enum([
    'requested',
    'open',
    'closed',
    'declined',
    'cancelled',
    'unknown',
  ]),
  requestedAt: timestamp.nullable(),
  approvedAt: timestamp.nullable(),
  closedAt: timestamp.nullable(),
  declineReason: z
    .enum(['return_period_ended', 'final_sale', 'other'])
    .nullable(),
  receivedAt: timestamp.nullable(),
  lines: z.array(
    z.object({
      orderLine: externalId.nullable(),
      quantity,
      reason: text,
      receivedQuantity: count6.nullable(),
      restockedQuantity: count6.nullable(),
      refundedQuantity: count6.nullable(),
      value: total,
    }),
  ),
});

const refundData = z.object({
  type: z.literal('refund'),
  order: externalId,
  return: externalId.nullable(),
  createdAt: timestamp.nullable(),
  total,
  lines: z.array(
    z.object({
      orderLine: externalId,
      quantity,
      restock: z.enum(['return', 'cancel', 'no_restock', 'unknown']),
      restocked: z.boolean(),
    }),
  ),
  transactions: z.array(
    z.object({
      status: z.enum(['success', 'pending', 'failed', 'unknown']),
      amount: total.unwrap(),
      processedAt: timestamp.nullable(),
      gateway: text,
    }),
  ),
});

export const outputs = {
  'orders.read': page(
    observation(
      'order',
      z.object({
        displayNumber: z.string().nullable(),
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
            currentQuantity: quantity,
            cancelledQuantity: quantity.nullable(),
            unitPrice: z
              .object({
                amount: decimal,
                currency: z.string().regex(/^[A-Z]{3}$/),
              })
              .nullable()
              .optional(),
            taxIncluded: z.boolean().nullable().optional(),
            taxRate: decimal.nullable().optional(),
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
        lines: z.array(
          z.object({
            orderLine: externalId,
            quantity,
            remainingQuantity: quantity.optional(),
          }),
        ),
        lastProgressAt: timestamp.nullable(),
        progressBasis: z
          .enum(['note_created_or_package_shipped', 'source_updated'])
          .optional(),
        failureCode: z.string().nullable(),
        kind: z.enum(['fulfillment_order', 'shipment']),
        holds: z
          .array(
            z.object({
              reason: z.enum([
                'awaiting_payment',
                'high_risk_of_fraud',
                'incorrect_address',
                'inventory_out_of_stock',
                'unknown_delivery_date',
                'awaiting_return_items',
                'other',
              ]),
            }),
          )
          .optional(),
        location: z
          .object({ id: externalId, name: z.string().min(1).nullable() })
          .nullable(),
        fulfillAt: timestamp.nullable().optional(),
        fulfillBy: timestamp.nullable().optional(),
        estimatedDeliveryAt: timestamp.nullable().optional(),
        method: z
          .object({
            type: z.enum([
              'shipping',
              'pick_up',
              'pickup_point',
              'local',
              'retail',
              'none',
              'unknown',
            ]),
            name: z.string().min(1).nullable(),
          })
          .nullable()
          .optional(),
        tracking: z
          .array(
            z.object({
              carrier: z.string().min(1).nullable(),
              number: z.string().min(1).nullable(),
              url: z.string().url().nullable(),
            }),
          )
          .optional(),
        delivery: z
          .enum([
            'label_created',
            'in_transit',
            'out_for_delivery',
            'attempted_delivery',
            'delayed',
            'ready_for_pickup',
            'delivered',
            'failed',
          ])
          .nullable()
          .optional(),
      }),
    ),
  ),
  'returns.read': page(
    observation(
      z.enum(['return', 'refund']),
      z.discriminatedUnion('type', [returnData, refundData]),
    ).refine((item) => item.source.resource === item.data.type),
  ),
};

const pageInput = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

const changedInput = pageInput.extend({
  updatedSince: timestamp.optional(),
  createdSince: timestamp.optional(),
  historyImport: z
    .object({
      key: z.string().uuid(),
      chunkSize: z.number().int().min(1).max(1000).optional(),
    })
    .strict()
    .optional(),
});

const scoped = (type: string) =>
  z.object({ externalId: gid(type), scopeKey: z.literal('') }).strict();

export const inputs = {
  'orders.read': changedInput.extend({
    confirmMissing: scoped('Order')
      .extend({ createdAt: timestamp.nullable() })
      .optional(),
  }),
  'products.read': changedInput.extend({
    confirmMissing: scoped('Product')
      .extend({ createdAt: timestamp.nullable() })
      .optional(),
  }),
  'customers.read': changedInput,
  'inventory.read': pageInput.extend({
    confirmMissing: z
      .object({
        externalId: gid('InventoryItem'),
        scopeKey: gid('Location'),
        createdAt: timestamp.nullable(),
      })
      .strict()
      .optional(),
    historyImport: z
      .object({
        key: z.string().uuid(),
        chunkSize: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    sku: scoped('InventoryItem').optional(),
    location: scoped('Location').optional(),
  }),
  'fulfillment.read': changedInput.extend({
    order: scoped('Order').optional(),
  }),
  'returns.read': changedInput.extend({
    order: scoped('Order').optional(),
  }),
};

// Provider records read for returns.read. Descriptive facts become unknown when malformed.
const shopMoney = z
  .object({ shopMoney: money })
  .nullable()
  .optional()
  .catch(null);

export const returnNode = z.object({
  id: gid('Return'),
  name: z.string().nullable().optional().catch(null),
  status: z.string(),
  createdAt: timestamp.nullable().optional().catch(null),
  requestApprovedAt: timestamp.nullable().optional().catch(null),
  closedAt: timestamp.nullable().optional().catch(null),
  decline: z.object({ reason: z.string() }).nullable().optional().catch(null),
});

export const returnLine = z.object({
  id: z
    .string()
    .regex(/^gid:\/\/shopify\/(Unverified)?ReturnLineItem\/[0-9]+$/),
  quantity: count,
  refundedQuantity: count.nullable().optional().catch(null),
  returnReasonDefinition: z
    .object({ name: z.string() })
    .nullable()
    .optional()
    .catch(null),
  // Only verified lines are tied to a fulfilled order line.
  fulfillmentLineItem: z
    .object({
      id: gid('FulfillmentLineItem'),
      lineItem: z.object({ id: gid('LineItem') }),
    })
    .nullable()
    .optional(),
  withCodeDiscountedTotalPriceSet: shopMoney,
});

export const reverseFulfillmentOrder = z.object({
  id: gid('ReverseFulfillmentOrder'),
  status: z.string(),
});

export const reverseLine = z.object({
  id: gid('ReverseFulfillmentOrderLineItem'),
  fulfillmentLineItem: z.object({ id: gid('FulfillmentLineItem') }).nullable(),
  dispositions: z.array(
    z.object({ type: z.string(), quantity: count, createdAt: timestamp }),
  ),
});

export const refundNode = z.object({
  id: gid('Refund'),
  createdAt: timestamp.nullable(),
  updatedAt: timestamp,
  totalRefundedSet: shopMoney,
  return: z.object({ id: gid('Return') }).nullable(),
});

export const refundLine = z.object({
  quantity: count,
  restockType: z.string(),
  restocked: z.boolean(),
  lineItem: z.object({ id: gid('LineItem') }),
});

export const refundTransaction = z.object({
  id: gid('OrderTransaction'),
  kind: z.string(),
  status: z.string(),
  processedAt: timestamp.nullable(),
  gateway: z.string().nullable().optional().catch(null),
  amountSet: z.object({ shopMoney: money }),
});

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
