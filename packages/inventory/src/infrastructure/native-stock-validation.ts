import { z } from 'zod';

import type {
  AllocationInput,
  ReleaseInput,
} from '../application/native-stock.js';
import { decimalQuantity, quantityUnits } from '../domain/ledger.js';

const uuid = z.string().uuid(),
  quantity = z
    .string()
    .regex(/^\d{1,18}(?:\.\d{1,6})?$/)
    .transform((value) => decimalQuantity(quantityUnits(value)));
const version = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
  .transform((value) => String(BigInt(value)));
const time = z.string().datetime({ offset: true });
const unit = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value === value.trim());

export const reservationSchema = z
  .object({
    id: uuid,
    orderId: uuid,
    orderLineId: uuid,
    skuId: uuid,
    locationId: uuid,
    unit,
    version,
    allocated: quantity,
    remaining: quantity,
    consumed: quantity,
    released: quantity,
    expiresAt: time.nullable(),
    state: z.enum(['active', 'released', 'consumed', 'expired']),
    createdAt: time,
    updatedAt: time,
  })
  .strict();

export const scopeSchema = z
  .object({
    connectionId: uuid,
    locationId: uuid,
    version,
    mode: z.enum(['observe', 'shadow', 'propose', 'own']),
    authorityRevision: z.number().int().nonnegative(),
    lastTransitionId: uuid.nullable(),
    updatedAt: time.nullable(),
  })
  .strict();

const ownershipBindingSchema = z
  .object({
    connectionId: uuid,
    locationId: uuid,
    authorityRevision: z.number().int().nonnegative(),
    scopeVersion: version,
    pools: z
      .array(
        z
          .object({
            skuId: uuid,
            unit,
            openingReviewId: uuid,
            comparisonId: uuid.nullable(),
            channelHandover: z
              .object({ snapshotId: uuid, meaningHash: z.string() })
              .optional(),
            mappingVersion: z.string().min(1),
            accountVersions: z
              .array(z.object({ id: uuid, version }).strict())
              .max(5000),
          })
          .strict(),
      )
      .max(5000),
    reservationVersions: z
      .array(z.object({ id: uuid, version }).strict())
      .max(10000),
  })
  .strict();

export const ownershipReviewSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    from: z.enum(['observe', 'shadow', 'propose', 'own']),
    to: z.enum(['observe', 'shadow', 'propose', 'own']),
    binding: ownershipBindingSchema,
    preparedBy: z.string().min(1),
    reviewedBy: z.string().nullable(),
    state: z.enum(['pending', 'approved', 'rejected']),
    reason: z.string().min(1).max(1024),
    createdAt: time,
    reviewedAt: time.nullable(),
  })
  .strict();

export const shipmentReadSchema = z
  .object({
    id: uuid,
    connectionId: uuid,
    orderId: uuid,
    orderExternalId: z.string().min(1).max(1024),
    orderScopeKey: z.string().max(1024),
    observedAt: time,
    complete: z.boolean(),
    mappingVersion: z.string().min(1),
    bindings: z
      .array(
        z
          .object({
            resource: z.enum([
              'order',
              'order_line',
              'location',
              'fulfillment',
            ]),
            externalId: z.string().min(1).max(1024),
            scopeKey: z.string().max(1024),
            canonicalId: uuid,
            mappingId: uuid,
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    shipments: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1024),
            snapshotId: uuid,
            observationId: uuid,
            locationId: uuid.nullable(),
            status: z.enum([
              'shipped',
              'delivered',
              'cancelled',
              'pending',
              'unknown',
            ]),
            lines: z
              .array(z.object({ orderLineId: uuid, quantity, unit }).strict())
              .max(5000),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
const allocationSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    reservationId: uuid,
    orderId: uuid,
    orderLineId: uuid,
    orderVersion: z.number().int().positive(),
    connectionId: uuid,
    locationId: uuid,
    quantity,
    unit,
    expiresAt: time.nullable(),
    reservationVersion: version.nullable(),
    available: z.object({ balance: quantity, version }).strict(),
    ownershipVersion: version,
    authorityRevision: z.number().int().nonnegative(),
    shipmentReadId: uuid,
  })
  .strict();
const releaseSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    reservationId: uuid,
    version,
    quantity,
    reason: z.enum(['release', 'cancel', 'amend', 'expiry']),
    shipmentReadId: uuid,
  })
  .strict();

/** Normalizes exact allocation input before Inventory application admission. */
export function parseAllocation(input: AllocationInput): AllocationInput {
  return allocationSchema.parse(input);
}

/** Validates the current reservation and fresh read identifiers for release. */
export function parseRelease(input: ReleaseInput): ReleaseInput {
  return releaseSchema.parse(input);
}
