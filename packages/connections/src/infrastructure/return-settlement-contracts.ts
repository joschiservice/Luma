import { z } from 'zod';

import { citedReadsSchema } from './cited-read-contracts.js';

const ref = z
  .object({
    externalId: z.string().min(1).max(200),
    scopeKey: z.string().max(1024),
  })
  .strict();
const quantity = z.number().int().min(1).max(1_000_000);
const decimal = z.string().regex(/^\d{1,14}(?:\.\d{1,6})?$/);
const refund = z
  .object({
    kind: z.literal('refund'),
    order: ref,
    lines: z
      .array(z.object({ orderLine: ref, quantity }).strict())
      .min(1)
      .max(100),
  })
  .strict();
const restock = z
  .object({ kind: z.literal('restock'), item: ref, warehouse: ref, quantity })
  .strict();

/** Validates the shared provider quote request; adapters additionally validate their own IDs. */
export const returnSettlementQuoteSchema = z.discriminatedUnion('kind', [
  refund,
  restock,
]);

/** Validates frozen provider-calculated amounts and warehouse baselines. */
const returnSettlementPlanSchema = z.discriminatedUnion('kind', [
  refund.extend({
    amount: decimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    transactions: z
      .array(
        z
          .object({
            parentId: z.string().min(1),
            gateway: z.string().min(1),
            amount: decimal,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  }),
  restock.extend({
    baselineOnHand: z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/),
  }),
]);

/** Validates operation identity and its immutable approved plan. */
export const returnSettlementWriteSchema = z
  .object({ operationId: z.string().uuid(), plan: returnSettlementPlanSchema })
  .strict();

/** Validates independently read outcomes; a payment may be pending or failed. */
export const returnSettlementProofSchema = z
  .object({
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    payment: z.enum(['pending', 'failed', 'partial', 'paid']).nullable(),
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()),
    reads: citedReadsSchema,
  })
  .strict();

/** Validates a quote with the time and persisted evidence of its source read. */
export const returnSettlementQuotedSchema = z
  .object({
    plan: returnSettlementPlanSchema,
    observedAt: z.string().datetime(),
    evidenceRefs: z.array(z.string().uuid()).min(1),
    reads: citedReadsSchema,
  })
  .strict();
