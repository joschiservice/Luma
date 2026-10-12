import { z } from 'zod';

const uuid = z.string().uuid();

const stockQuantitySchema = z.string().regex(/^-?\d{1,18}(?:\.\d{1,6})?$/);

const stockVersionSchema = z.string().regex(/^\d{1,19}$/);
const time = z.string().datetime({ offset: true }),
  unit = z.string().min(1).max(64);

export const nativeScopeSchema = z.object({
  connectionId: uuid,
  locationId: uuid,
  version: stockVersionSchema,
  mode: z.enum(['observe', 'shadow', 'propose', 'own']),
  authorityRevision: z.number().int().nonnegative(),
  lastTransitionId: uuid.nullable(),
  updatedAt: time.nullable(),
});

const nativeAccountSchema = z.object({
  id: uuid,
  address: z.object({
    skuId: uuid,
    locationId: uuid,
    unit,
    state: z.enum([
      'available',
      'reserved',
      'held',
      'quarantine',
      'damaged',
      'returned_inspection',
      'incoming',
      'in_transit',
      'supplier',
      'customer',
      'loss',
      'adjustment',
      'production',
      'external',
    ]),
    connectionId: uuid.optional(),
  }),
  balance: stockQuantitySchema,
  version: stockVersionSchema,
});

const nativeReservationSchema = z.object({
  id: uuid,
  orderId: uuid,
  orderLineId: uuid,
  skuId: uuid,
  locationId: uuid,
  unit,
  version: stockVersionSchema,
  allocated: stockQuantitySchema,
  remaining: stockQuantitySchema,
  consumed: stockQuantitySchema,
  released: stockQuantitySchema,
  expiresAt: time.nullable(),
  state: z.enum(['active', 'released', 'consumed', 'expired']),
  createdAt: time,
  updatedAt: time,
});

export const nativeLedgerReceiptSchema = z.object({
  id: uuid,
  key: z.string(),
  commandHash: z.string(),
  entryId: uuid.nullable(),
  reviewId: uuid.nullable(),
  recordedAt: time,
  accounts: z.array(nativeAccountSchema).max(5000),
});

export const nativeReservationResultSchema = z.object({
  key: z.string(),
  commandHash: z.string(),
  reservation: nativeReservationSchema.nullable(),
  allocated: stockQuantitySchema,
  unallocated: stockQuantitySchema,
  ledger: nativeLedgerReceiptSchema.nullable(),
  orderVersion: z.number().int().nonnegative(),
});

export const nativeAllocationSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    reservationId: uuid,
    orderId: uuid,
    orderLineId: uuid,
    orderVersion: z.number().int().positive(),
    connectionId: uuid,
    locationId: uuid,
    quantity: stockQuantitySchema,
    unit,
    expiresAt: time.nullable(),
    reservationVersion: stockVersionSchema.nullable(),
    available: z.object({
      balance: stockQuantitySchema,
      version: stockVersionSchema,
    }),
    ownershipVersion: stockVersionSchema,
    authorityRevision: z.number().int().nonnegative(),
    shipmentReadId: uuid,
  })
  .strict();

export const nativeReleaseSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    reservationId: uuid,
    version: stockVersionSchema,
    quantity: stockQuantitySchema,
    reason: z.enum(['release', 'cancel', 'amend', 'expiry']),
    shipmentReadId: uuid,
  })
  .strict();

export const nativeConsumptionInputSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    orderId: uuid,
    shipmentReadId: uuid,
    expected: z
      .array(z.object({ id: uuid, version: stockVersionSchema }))
      .max(5000),
  })
  .strict();

export const nativeConsumptionResultSchema = z.object({
  key: z.string(),
  commandHash: z.string(),
  consumed: stockQuantitySchema,
  reservations: z.array(nativeReservationSchema).max(5000),
  ledger: z.array(nativeLedgerReceiptSchema).max(5000),
  shipmentReadId: uuid,
});

export const nativeOwnershipInputSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    connectionId: uuid,
    locationId: uuid,
    version: stockVersionSchema,
    to: z.enum(['observe', 'shadow', 'propose', 'own']),
    reason: z.string().trim().min(1).max(1024),
  })
  .strict();
const bindingSchema = z.object({
  connectionId: uuid,
  locationId: uuid,
  authorityRevision: z.number().int().nonnegative(),
  scopeVersion: stockVersionSchema,
  pools: z
    .array(
      z.object({
        skuId: uuid,
        unit,
        openingReviewId: uuid,
        comparisonId: uuid,
        mappingVersion: z.string(),
        accountVersions: z
          .array(z.object({ id: uuid, version: stockVersionSchema }))
          .max(5000),
      }),
    )
    .max(5000),
  reservationVersions: z
    .array(z.object({ id: uuid, version: stockVersionSchema }))
    .max(10000),
});

export const nativeOwnershipReviewSchema = z.object({
  id: uuid,
  key: z.string(),
  intentHash: z.string(),
  from: nativeScopeSchema.shape.mode,
  to: nativeScopeSchema.shape.mode,
  binding: bindingSchema,
  preparedBy: z.string(),
  reviewedBy: z.string().nullable(),
  state: z.enum(['pending', 'approved', 'rejected']),
  reason: z.string(),
  createdAt: time,
  reviewedAt: time.nullable(),
});

export const nativePoolSchema = z.object({
  skuId: uuid,
  locationId: uuid,
  unit,
  scope: nativeScopeSchema,
  opened: z.boolean(),
  ownershipReviews: z
    .array(
      z.object({
        id: uuid,
        from: nativeScopeSchema.shape.mode,
        to: nativeScopeSchema.shape.mode,
        preparedBy: z.string(),
        state: z.enum(['pending', 'approved', 'rejected']),
      }),
    )
    .max(20),
  accounts: z.array(nativeAccountSchema).max(5000),
  pendingReviews: z
    .array(
      z.object({
        id: uuid,
        purpose: z.string(),
        preparedBy: z.string(),
        state: z.enum(['pending', 'approved', 'rejected']),
        createdAt: time,
      }),
    )
    .max(20),
});

export const nativeOrderStockSchema = z.object({
  demand: z
    .object({
      orderId: uuid,
      connectionId: uuid,
      version: z.number().int().positive(),
      status: z.enum(['open', 'completed', 'cancelled']),
      lines: z
        .array(
          z.object({
            id: uuid,
            skuId: uuid.nullable(),
            skuCode: z.string().nullable(),
            title: z.string().nullable(),
            unit,
            currentQuantity: stockQuantitySchema,
          }),
        )
        .max(5000),
    })
    .nullable()
    .describe(
      'Retained native demand for stock managers. It excludes addresses and prices and does not grant allocation authority.',
    ),
  orderId: uuid,
  reservations: z.array(nativeReservationSchema).max(5000),
});

export const nativeShipmentReadSchema = z.object({
  id: uuid,
  connectionId: uuid,
  orderId: uuid,
  orderExternalId: z.string(),
  orderScopeKey: z.string(),
  observedAt: time,
  complete: z.boolean(),
  mappingVersion: z.string(),
  bindings: z
    .array(
      z.object({
        resource: z.enum(['order', 'order_line', 'location', 'fulfillment']),
        externalId: z.string(),
        scopeKey: z.string(),
        canonicalId: uuid,
        mappingId: uuid,
      }),
    )
    .max(10000),
  shipments: z
    .array(
      z.object({
        id: z.string(),
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
          .array(
            z.object({
              orderLineId: uuid,
              quantity: stockQuantitySchema,
              unit,
            }),
          )
          .max(5000),
      }),
    )
    .max(5000),
});

export const nativeOpeningInputSchema = z
  .object({
    id: uuid,
    key: z.string().min(1).max(256),
    snapshotId: uuid,
    reason: z.string().trim().min(1).max(1024),
    balances: z
      .object({
        available: stockQuantitySchema.optional(),
        held: stockQuantitySchema.optional(),
        quarantine: stockQuantitySchema.optional(),
        damaged: stockQuantitySchema.optional(),
        returned_inspection: stockQuantitySchema.optional(),
        incoming: stockQuantitySchema.optional(),
      })
      .strict(),
  })
  .strict();

export const nativeStockEvidenceSchema = z.object({
  snapshotId: uuid,
  observationId: uuid,
  connectionId: uuid,
  skuId: uuid,
  locationId: uuid,
  unit,
  onHand: stockQuantitySchema.nullable(),
  available: stockQuantitySchema.nullable(),
  incoming: stockQuantitySchema.nullable(),
  observedAt: time,
  sourceUpdatedAt: time.nullable(),
  mappingVersion: z.string(),
  sourceRevision: z.string().nullable(),
  meaningHash: z.string(),
  complete: z.boolean(),
  bundleParent: z.boolean().nullable(),
  channelState: z
    .object({
      semantics: z.literal('shopify/1'),
      committed: stockQuantitySchema.nullable(),
      reserved: stockQuantitySchema.nullable(),
      itemActive: z.boolean().nullable(),
      locationActive: z.boolean().nullable(),
      tracked: z.boolean().nullable(),
    })
    .nullable()
    .optional(),
});
const address = nativeAccountSchema.shape.address;

export const nativeLedgerReviewSchema = z.object({
  id: uuid,
  commandKey: z.string(),
  commandHash: z.string(),
  intentHash: z.string(),
  command: z.object({
    id: uuid,
    key: z.string(),
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
    ]),
    reason: z.string(),
    effectiveAt: time.nullable(),
    evidence: z
      .array(
        z.object({
          kind: z.enum(['observation', 'review', 'entry', 'shipment']),
          id: uuid,
        }),
      )
      .max(5000),
    postings: z
      .array(z.object({ account: address, quantity: stockQuantitySchema }))
      .max(5000),
    expected: z
      .array(
        z.object({
          account: address,
          balance: stockQuantitySchema,
          version: stockVersionSchema,
        }),
      )
      .max(5000),
    reversalOf: uuid.optional(),
  }),
  sources: z.array(nativeStockEvidenceSchema).max(5000),
  preparedBy: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: time.nullable(),
  state: z.enum(['pending', 'approved', 'rejected']),
  createdAt: time,
});

export const nativeComparisonSchema = z.object({
  id: uuid,
  key: z.string(),
  source: nativeStockEvidenceSchema,
  nativeQuantity: stockQuantitySchema,
  driftQuantity: stockQuantitySchema,
  nativeVersions: z
    .array(z.object({ accountId: uuid, version: stockVersionSchema }))
    .max(5000),
  entryId: uuid.nullable(),
});
