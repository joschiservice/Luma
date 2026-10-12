import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  nativeAllocationSchema,
  nativeComparisonSchema,
  nativeConsumptionInputSchema,
  nativeConsumptionResultSchema,
  nativeLedgerReceiptSchema,
  nativeLedgerReviewSchema,
  nativeOpeningInputSchema,
  nativeOrderStockSchema,
  nativeOwnershipInputSchema,
  nativeOwnershipReviewSchema,
  nativePoolSchema,
  nativeReleaseSchema,
  nativeReservationResultSchema,
  nativeScopeSchema,
  nativeShipmentReadSchema,
  nativeStockEvidenceSchema,
} from '../native-stock.js';

const base = '/v1/organizations/{organizationId}/inventory/native';
const errors = [400, 401, 403, 404, 409, 422, 503] as const;

export const nativeStockContract = {
  readStock: endpoint
    .route({
      method: 'POST',
      path: `${base}/stock-reads`,
      summary: 'Independently read one exact native stock source',
      description:
        'Retains complete stock and composition evidence through Inventory. Provider observations never overwrite native balances.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            connectionId: z.string().uuid(),
            skuId: z.string().uuid(),
            locationId: z.string().uuid(),
            unit: z.string().min(1).max(64),
          })
          .strict(),
      }),
    )
    .output(nativeStockEvidenceSchema),
  prepareOpening: endpoint
    .route({
      method: 'POST',
      path: `${base}/opening-reviews`,
      summary: 'Prepare exact native opening balances',
      description:
        'Requires complete fresh stock-bearing source evidence. Another current member reviews the exact baseline before any native stock is opened.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: nativeOpeningInputSchema,
      }),
    )
    .output(nativeLedgerReviewSchema),
  ledgerReview: endpoint
    .route({
      method: 'GET',
      path: `${base}/ledger-reviews/{reviewId}`,
      summary: 'Read proposed stock movements and source evidence',
    })
    .meta({ access: requires('inventory.read'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
      }),
    )
    .output(nativeLedgerReviewSchema),
  reviewLedger: endpoint
    .route({
      method: 'POST',
      path: `${base}/ledger-reviews/{reviewId}/decision`,
      summary: 'Review another member’s stock movements',
    })
    .meta({ access: requires('inventory.approve'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
        body: z.object({ approved: z.boolean() }).strict(),
      }),
    )
    .output(nativeLedgerReviewSchema),
  applyLedger: endpoint
    .route({
      method: 'POST',
      path: `${base}/ledger-reviews/{reviewId}/apply`,
      summary: 'Post approved stock movements',
      description:
        'Rechecks current source evidence, memberships and balance versions. An identical retry returns the original receipt.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
      }),
    )
    .output(nativeLedgerReceiptSchema),
  reconcile: endpoint
    .route({
      method: 'POST',
      path: `${base}/reconciliations`,
      summary: 'Compare independent source stock to native balances',
      description:
        'Records source drift through virtual accounts. Provider quantities never overwrite physical native stock.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            id: z.string().uuid(),
            key: z.string().min(1).max(256),
            snapshotId: z.string().uuid(),
          })
          .strict(),
      }),
    )
    .output(nativeComparisonSchema),
  pool: endpoint
    .route({
      method: 'GET',
      path: `${base}/pools/{skuId}/locations/{locationId}/sources/{connectionId}`,
      summary: 'Read recorded native stock',
      description:
        'Native balances stay separate from provider observations. Unopened pools have no native opening, even when prepared zero accounts exist.',
    })
    .meta({ access: requires('inventory.read'), errors: [401, 403, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          skuId: z.string().uuid(),
          locationId: z.string().uuid(),
          connectionId: z.string().uuid(),
        }),
        query: z.object({ unit: z.string().min(1).max(64) }),
      }),
    )
    .output(nativePoolSchema),
  order: endpoint
    .route({
      method: 'GET',
      path: `${base}/orders/{orderId}`,
      summary: 'Read exact order stock reservations',
    })
    .meta({ access: requires('orders.read'), errors: [401, 403, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ orderId: z.string().uuid() }),
      }),
    )
    .output(nativeOrderStockSchema),
  allocate: endpoint
    .route({
      method: 'POST',
      path: `${base}/allocations`,
      summary: 'Allocate exact remaining order demand',
      description:
        'Requires native order authority, reviewed location ownership and complete fresh shipment evidence. Shortages remain unallocated demand. No provider write is sent.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: nativeAllocationSchema,
      }),
    )
    .output(nativeReservationResultSchema),
  release: endpoint
    .route({
      method: 'POST',
      path: `${base}/releases`,
      summary: 'Release remaining native stock',
      description:
        'New verified shipments must be consumed first. A release cannot restore consumed stock. Identical retries return the original receipt.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({ params: organizationParamsSchema, body: nativeReleaseSchema }),
    )
    .output(nativeReservationResultSchema),
  consume: endpoint
    .route({
      method: 'POST',
      path: `${base}/shipment-consumptions`,
      summary: 'Consume independently verified shipped units',
      description:
        'Only exact shipment, order-line, location and unit identities consume remaining reservations. Fulfillment preparation sends no stock.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: nativeConsumptionInputSchema,
      }),
    )
    .output(nativeConsumptionResultSchema),
  shipments: endpoint
    .route({
      method: 'POST',
      path: `${base}/orders/{orderId}/shipment-reads`,
      summary: 'Independently read complete shipment evidence',
      description:
        'Requires fulfillment and import access. Reads one exact mapped source order, preserving complete empty reads and current mapping bindings.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ orderId: z.string().uuid() }),
        body: z.object({ connectionId: z.string().uuid() }).strict(),
      }),
    )
    .output(nativeShipmentReadSchema),
  ownershipReview: endpoint
    .route({
      method: 'GET',
      path: `${base}/ownership-reviews/{reviewId}`,
      summary: 'Read the exact stock ownership proposal',
    })
    .meta({ access: requires('inventory.read'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
      }),
    )
    .output(nativeOwnershipReviewSchema),
  prepareOwnership: endpoint
    .route({
      method: 'POST',
      path: `${base}/ownership-reviews`,
      summary: 'Prepare a versioned location ownership step',
      description:
        'Binds reviewed openings, current reconciliation, source mappings, account and reservation versions and workspace authority. Pending external effects prevent handover.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: nativeOwnershipInputSchema,
      }),
    )
    .output(nativeOwnershipReviewSchema),
  reviewOwnership: endpoint
    .route({
      method: 'POST',
      path: `${base}/ownership-reviews/{reviewId}/decision`,
      summary: 'Review another member’s exact ownership step',
    })
    .meta({ access: requires('inventory.approve'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
        body: z.object({ approved: z.boolean() }).strict(),
      }),
    )
    .output(nativeOwnershipReviewSchema),
  applyOwnership: endpoint
    .route({
      method: 'POST',
      path: `${base}/ownership-reviews/{reviewId}/apply`,
      summary: 'Apply an approved location ownership step',
      description:
        'Rechecks source evidence, current reviewer grants, stock versions and authority. Activation and provider stock publication are separate controlled capabilities.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          reviewId: z.string().uuid(),
        }),
      }),
    )
    .output(nativeScopeSchema),
  expire: endpoint
    .route({
      method: 'POST',
      path: `${base}/expiry`,
      summary: 'Release due holds with fresh evidence',
      description:
        'Processes at most 200 due holds. Stale or uncertain evidence leaves the reservation intact and returns its blocking reason.',
    })
    .meta({ access: requires('inventory.manage'), errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z.object({
          limit: z.number().int().min(1).max(200).default(100),
          orderId: z.string().uuid().optional(),
        }),
      }),
    )
    .output(
      z.object({
        released: z.array(z.string().uuid()).max(200),
        blocked: z
          .array(z.object({ id: z.string().uuid(), code: z.string() }))
          .max(200),
        hasMore: z.boolean(),
      }),
    ),
};
