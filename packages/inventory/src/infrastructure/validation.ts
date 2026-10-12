import { z } from 'zod';

import {
  shipmentDataSchema,
  transferDataSchema,
} from './transfer-validation.js';

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
    schemaVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ]),
    kind: z.literal('position'),
    data: z
      .object({
        type: z.literal('position'),
        composition: z
          .object({
            variant: z
              .object({
                externalId: z.string().min(1).max(1024),
                scopeKey: z.string().max(1024),
              })
              .strict(),
            requiresComponents: z.boolean(),
            hasComponents: z.boolean(),
          })
          .strict()
          .nullable()
          .optional(),
        skuId: uuid,
        locationId: uuid,
        unit: z.string().min(1).max(64),
        onHand: decimal.nullable(),
        reserved: decimal.nullable(),
        available: decimal.nullable(),
        committed: decimal.nullable().optional(),
        incoming: decimal.nullable().optional(),
        damaged: decimal.nullable().optional(),
        qualityControl: decimal.nullable().optional(),
        safetyStock: decimal.nullable().optional(),
        locationActive: z.boolean().nullable().optional(),
        itemActive: z.boolean().nullable().optional(),
        tracked: z.boolean().nullable().optional(),
        inventorySemantics: z.literal('shopify/1').nullable().optional(),
        writeAttribution: z
          .object({
            evidenceId: uuid,
            adjustmentId: z
              .string()
              .regex(/^gid:\/\/shopify\/InventoryAdjustmentGroup\/[0-9]+$/),
            referenceDocumentUri: z.string().min(1).max(1024),
            available: decimal,
            quantityMatches: z.boolean().nullable(),
          })
          .strict()
          .nullable()
          .optional(),
        availabilityBasis: z.enum(['provider_reported', 'derived', 'unknown']),
      })
      .strict(),
  })
  .strict();

// Earlier catalog snapshots stay readable; version 3 adds independently sourced bundle recipes.
const product = base
  .extend({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.literal('product'),
    data: z
      .object({
        type: z.literal('product'),
        title: z.string().max(1024).nullable(),
        status: z.enum(['active', 'draft', 'archived', 'unknown']),
        vendor: z.string().max(1024).nullable().optional(),
        published: z.boolean().nullable().optional(),
        skus: z
          .array(
            z
              .object({
                skuId: uuid,
                code: z.string().max(1024).nullable(),
                unit: z.string().min(1).max(64),
                title: z.string().max(1024).nullable().optional(),
                price: z
                  .object({
                    amount: decimal,
                    currency: z
                      .string()
                      .regex(/^[A-Z]{3}$/)
                      .nullable(),
                  })
                  .strict()
                  .nullable()
                  .optional(),
                barcode: z.string().max(512).nullable().optional(),
                bundle: z
                  .object({
                    variant: z
                      .object({
                        externalId: z.string().min(1).max(1024),
                        scopeKey: z.string().max(1024),
                      })
                      .strict(),
                    requiresComponents: z.boolean(),
                    components: z
                      .array(
                        z
                          .object({
                            sourceId: z
                              .object({
                                externalId: z.string().min(1).max(1024),
                                scopeKey: z.string().max(1024),
                              })
                              .strict(),
                            sourceVariant: z
                              .object({
                                externalId: z.string().min(1).max(1024),
                                scopeKey: z.string().max(1024),
                              })
                              .strict(),
                            sourceSku: z
                              .object({
                                externalId: z.string().min(1).max(1024),
                                scopeKey: z.string().max(1024),
                              })
                              .strict()
                              .nullable(),
                            skuId: uuid.nullable(),
                            quantity: decimal.refine((v) => !v.startsWith('-')),
                          })
                          .strict(),
                      )
                      .max(5000)
                      .nullable(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .max(5000)
          .refine(
            (skus) =>
              skus.reduce(
                (sum, sku) => sum + (sku.bundle?.components?.length ?? 0),
                0,
              ) <= 5000,
            'Product component budget exceeded',
          ),
      })
      .strict(),
  })
  .strict();

export const snapshotSchema = z.discriminatedUnion('kind', [
  position,
  product,
  base
    .extend({ kind: z.literal('inventory_transfer'), data: transferDataSchema })
    .strict(),
  base
    .extend({ kind: z.literal('inventory_shipment'), data: shipmentDataSchema })
    .strict(),
]);
