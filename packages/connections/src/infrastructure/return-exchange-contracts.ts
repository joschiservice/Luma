import { z } from 'zod';

const ref = z
  .object({
    externalId: z.string().min(1).max(200),
    scopeKey: z.string().max(1024),
  })
  .strict();
const quantity = z.number().int().min(1).max(1_000_000);
const amount = z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/);
const replacement = z
  .object({
    skuId: z.string().uuid(),
    mappingIds: z.array(z.string().uuid()).min(2).max(10),
    inventoryItem: ref,
    variantId: z.string().min(1).max(200),
    wawiConnectionId: z.string().uuid(),
    item: ref,
    quantity,
  })
  .strict();
const financial = z
  .object({
    kind: z.enum(['even', 'charge', 'refund']),
    amount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    transactions: z
      .array(z.object({ parentId: z.string().min(1), amount }).strict())
      .max(20),
    priorSuccessfulTransactionIds: z.array(z.string().min(1)).max(100),
  })
  .strict();
const marker = z.string().regex(/^luma-ex:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
const plan = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('request'),
      marker,
      order: ref,
      lines: z
        .array(
          z
            .object({
              orderLineId: z.string().uuid(),
              source: ref,
              quantity,
              reason: z.string().min(1).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      replacement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('process'),
      marker,
      order: ref,
      returnId: z.string().min(1),
      returnLines: z
        .array(z.object({ id: z.string().min(1), quantity }).strict())
        .min(1)
        .max(20),
      exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      replacement,
      financial,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel'),
      marker,
      order: ref,
      returnId: z.string().min(1),
      lines: z
        .array(
          z
            .object({
              orderLineId: z.string().uuid(),
              source: ref,
              quantity,
              reason: z.string().min(1).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      replacement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('release'),
      marker,
      returnLines: z
        .array(z.object({ id: z.string().min(1), quantity }).strict())
        .min(1)
        .max(20),
      exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      replacement,
      order: ref,
      returnId: z.string().min(1),
      fulfillmentOrderId: z.string().min(1),
      holdId: z.string().min(1),
      financial,
    })
    .strict(),
]);

/** Validates the business operation identity and frozen provider step. Adapters also check provider-local IDs. */
export const returnExchangeReadSchema = z
  .object({ operationId: z.string().uuid(), plan })
  .strict()
  .refine(
    (value) =>
      !('marker' in value.plan) ||
      value.plan.marker.startsWith(`luma-ex:${value.operationId}:`),
    { message: 'Exchange marker must belong to its operation' },
  );

/** Validates a current source quote without treating available inventory as reserved. */
export const returnExchangeQuotedSchema = z
  .object({
    plan,
    available: z.boolean(),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
  })
  .strict();

/** Validates independently observed intent, fulfillment and payment outcomes. */
export const returnExchangeProofSchema = z
  .object({
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
    returnId: z.string().nullable(),
    processLines: z
      .object({
        returnLines: z
          .array(z.object({ id: z.string().min(1), quantity }).strict())
          .min(1)
          .max(20),
        exchangeLine: z.object({ id: z.string().min(1), quantity }).strict(),
      })
      .strict()
      .nullable(),
    fulfillmentOrderId: z.string().nullable(),
    paymentHoldId: z.string().nullable(),
    fulfillmentReady: z.boolean(),
    payment: z.enum([
      'not_required',
      'pending',
      'failed',
      'partial',
      'paid',
      'unknown',
    ]),
    financial: financial.nullable(),
  })
  .strict();

/** Validates the processed replacement price without equating a quote with actual settlement. */
export const exchangePriceSchema = z
  .object({
    total: z
      .object({ amount, currency: z.string().regex(/^[A-Z]{3}$/) })
      .strict()
      .nullable(),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
  })
  .strict();

/** Validates a tenant-bound operation lookup in the ERP stock owner. */
export const exchangeReservationInputSchema = z
  .object({ operationId: z.string().uuid(), item: ref })
  .strict();

/** Native marked orders and their reservations; incomplete scans never prove uniqueness. */
export const exchangeReservationSchema = z
  .object({
    complete: z.boolean(),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
    orders: z
      .array(
        z
          .object({
            id: ref,
            total: z
              .object({ amount, currency: z.string().regex(/^[A-Z]{3}$/) })
              .strict()
              .nullable(),
            paid: z.boolean(),
            cancelled: z.boolean(),
            exactLines: z.boolean(),
            quantity: z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/),
            reserved: z
              .string()
              .regex(/^\d{1,14}(?:\.\d{1,6})?$/)
              .nullable(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
