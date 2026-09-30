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

const position = base
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

const product = base
  .extend({
    kind: z.literal('product'),
    data: z
      .object({
        type: z.literal('product'),
        title: z.string().max(1024).nullable(),
        status: z.enum(['active', 'archived', 'unknown']),
        skus: z
          .array(
            z
              .object({
                skuId: uuid,
                code: z.string().max(1024).nullable(),
                unit: z.string().min(1).max(64),
              })
              .strict(),
          )
          .max(5000),
      })
      .strict(),
  })
  .strict();

export const snapshotSchema = z.discriminatedUnion('kind', [position, product]);
