import { z } from 'zod';

import type { LedgerInputParser } from '../application/ledger.js';
import {
  counterpartyStockStates,
  decimalQuantity,
  physicalStockStates,
  quantityUnits,
} from '../domain/ledger.js';

const uuid = z.string().uuid();
const quantity = z
  .string()
  .regex(/^-?\d{1,18}(?:\.\d{1,6})?$/)
  .transform((value) => decimalQuantity(quantityUnits(value)));
const version = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
  .transform((value) => String(BigInt(value)));
const addressBase = z.object({
  skuId: uuid,
  locationId: uuid,
  unit: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value === value.trim()),
});

export const addressSchema = z.union([
  addressBase
    .extend({
      state: z.enum([...physicalStockStates, ...counterpartyStockStates]),
    })
    .strict(),
  addressBase
    .extend({ state: z.literal('external'), connectionId: uuid })
    .strict(),
]);
const expected = z
  .object({ account: addressSchema, balance: quantity, version })
  .strict();

export const postingCommandSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    purpose: z.enum([
      'opening',
      'movement',
      'correction',
      'reversal',
      'reservation',
      'release',
      'dispatch',
      'reconciliation',
      'production',
      'purchase_receipt',
    ]),
    reason: z.string().trim().min(1).max(1024),
    effectiveAt: z.string().datetime({ offset: true }).nullable(),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['observation', 'review', 'entry', 'shipment']),
            id: uuid,
          })
          .strict(),
      )
      .max(128),
    postings: z
      .array(z.object({ account: addressSchema, quantity }).strict())
      .max(5000),
    expected: z.array(expected).max(5000),
    purchaseReceipt: z
      .object({
        purchaseOrderId: uuid,
        lineId: uuid,
        commitmentId: uuid,
        damagedCommitmentId: uuid.nullable(),
        cumulativeGood: quantity,
        cumulativeDamaged: quantity,
        previousGood: quantity,
        previousDamaged: quantity,
        scopeVersion: z.string().regex(/^\d+$/),
      })
      .strict()
      .optional(),
    reversalOf: uuid.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.postings.length >= 2 ||
      (value.purpose === 'opening' && value.postings.length === 0),
    'An entry needs at least two postings.',
  )
  .refine(
    (value) =>
      (value.purpose === 'purchase_receipt') === !!value.purchaseReceipt,
    'Receipt postings need an exact receipt binding.',
  );

const openingInputSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    snapshotId: uuid,
    reason: z.string().trim().min(1).max(1024),
    balances: z
      .object({
        available: quantity.optional(),
        held: quantity.optional(),
        quarantine: quantity.optional(),
        damaged: quantity.optional(),
        returned_inspection: quantity.optional(),
        incoming: quantity.optional(),
      })
      .strict(),
  })
  .strict();

export const ledgerReceiptSchema = z
  .object({
    id: uuid,
    key: z.string(),
    commandHash: z.string(),
    entryId: uuid.nullable(),
    reviewId: uuid.nullable(),
    recordedAt: z.string().datetime({ offset: true }),
    accounts: z.array(
      z
        .object({
          id: uuid,
          address: addressSchema,
          balance: quantity,
          version,
        })
        .strict(),
    ),
  })
  .strict();

export const ledgerInputParser: LedgerInputParser = {
  purchaseReceipt: (input) =>
    z
      .object({
        id: uuid,
        purchaseOrderId: uuid,
        lineId: uuid,
        reason: z.string().trim().min(1).max(1024),
      })
      .strict()
      .parse(input),
  command: (input) => postingCommandSchema.parse(input),
  opening: (input) => openingInputSchema.parse(input),
  historical: (input) =>
    z
      .object({
        account: addressSchema,
        effectiveAt: z.string().datetime({ offset: true }),
        recordedAt: z.string().datetime({ offset: true }),
        maximumVersion: version,
      })
      .strict()
      .parse(input),
  aging: (input) =>
    z
      .object({
        before: z.string().datetime({ offset: true }),
        limit: z.number().int().min(1).max(200),
      })
      .strict()
      .parse(input),
  reconcile: (input) =>
    z
      .object({ id: uuid, key: z.string().min(1).max(256), snapshotId: uuid })
      .strict()
      .parse(input),
  reversal: (input) =>
    z
      .object({
        id: uuid,
        key: z.string().min(1).max(256),
        entryId: uuid,
        reason: z.string().trim().min(1).max(1024),
        effectiveAt: z.string().datetime({ offset: true }).nullable(),
      })
      .strict()
      .parse(input),
};
