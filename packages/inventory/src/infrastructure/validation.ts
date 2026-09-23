import { z } from 'zod';

const uuid = z.string().uuid();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const timestamp = z.string().datetime({ offset: true });

const base = z.object({
  schemaVersion: z.literal(1),
  entityId: uuid,
  connectionId: uuid,
  observationId: uuid,
  normalizerVersion: z.string().min(1),
  mappingVersion: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().nullable(),
  sourceUpdatedAt: timestamp.nullable(),
  observedAt: timestamp,
  deleted: z.boolean(),
});

export const snapshotSchema = base
  .extend({
    kind: z.literal('position'),
    data: z
      .object({
        type: z.literal('position'),
        skuId: uuid,
        locationId: uuid,
        unit: z.string().min(1).max(64),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal.nullable(),
        availabilityBasis: z.enum(['provider_reported', 'derived', 'unknown']),
      })
      .strict(),
  })
  .strict();
