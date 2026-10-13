import '@luma/identity/http';

import {
  apiContract,
  nativeComparisonSchema,
  nativeConsumptionResultSchema,
  nativeLedgerReceiptSchema,
  nativeLedgerReviewSchema,
  nativeOrderStockSchema,
  nativeOwnershipReviewSchema,
  nativePoolSchema,
  nativeReservationResultSchema,
  nativeScopeSchema,
  nativeShipmentReadSchema,
  nativeStockEvidenceSchema,
} from '@luma/api-contract';
import { IdentityError, type TenantContext } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { NativeStockRuntime } from '../application/native-stock.js';
import { LedgerError } from '../domain/ledger.js';

/** Exposes native records and controlled owner operations; errors retain stale and unavailable states. */
export function nativeStockRoutes(service?: NativeStockRuntime) {
  const os = implement(apiContract.nativeStock).$context<HttpContext>();

  async function call<T>(
    context: HttpContext,
    operation: (
      service: NativeStockRuntime,
      tenant: TenantContext,
    ) => Promise<T>,
  ) {
    const tenant = context.request.tenantContext;
    if (!tenant)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Native stock is unavailable',
      );
    try {
      return await operation(service, tenant);
    } catch (error) {
      if (error instanceof LedgerError)
        throw new IdentityError(
          ['invalid_quantity', 'invalid_entry', 'unbalanced'].includes(
            error.code,
          )
            ? 422
            : 409,
          ['invalid_quantity', 'invalid_entry', 'unbalanced'].includes(
            error.code,
          )
            ? 'VALIDATION_ERROR'
            : 'CONFLICT',
          error.message,
        );
      throw error;
    }
  }

  return os.router({
    verifyPurchaseReceipt: os.verifyPurchaseReceipt.handler(
      async ({ context, input }) =>
        await call(context, (service, tenant) =>
          service.ledger.verifyPurchaseReceipt(tenant, input.params.reviewId),
        ),
    ),
    preparePurchaseReceipt: os.preparePurchaseReceipt.handler(
      async ({ context, input }) =>
        nativeLedgerReviewSchema.parse(
          await call(context, (service, tenant) =>
            service.ledger.preparePurchaseReceipt(tenant, input.body),
          ),
        ),
    ),
    purchaseReceiptReviews: os.purchaseReceiptReviews.handler(
      async ({ context, input }) =>
        await call(context, (service, tenant) =>
          service.ledger.purchaseReceiptReviews(
            tenant,
            input.params.purchaseOrderId,
          ),
        ),
    ),
    readStock: os.readStock.handler(async ({ context, input }) =>
      nativeStockEvidenceSchema.parse(
        await call(context, (service, tenant) =>
          service.readStock(tenant, input.body),
        ),
      ),
    ),
    prepareOpening: os.prepareOpening.handler(async ({ context, input }) =>
      nativeLedgerReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ledger.prepareOpening(tenant, input.body),
        ),
      ),
    ),
    ledgerReview: os.ledgerReview.handler(async ({ context, input }) =>
      nativeLedgerReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ledger.getReview(tenant, input.params.reviewId),
        ),
      ),
    ),
    reviewLedger: os.reviewLedger.handler(async ({ context, input }) =>
      nativeLedgerReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ledger.review(
            tenant,
            input.params.reviewId,
            input.body.approved,
          ),
        ),
      ),
    ),
    applyLedger: os.applyLedger.handler(async ({ context, input }) =>
      nativeLedgerReceiptSchema.parse(
        await call(context, (service, tenant) =>
          service.ledger.postReviewed(tenant, input.params.reviewId),
        ),
      ),
    ),
    reconcile: os.reconcile.handler(async ({ context, input }) =>
      nativeComparisonSchema.parse(
        await call(context, (service, tenant) =>
          service.ledger.reconcile(tenant, input.body),
        ),
      ),
    ),
    pool: os.pool.handler(async ({ context, input }) =>
      nativePoolSchema.parse(
        await call(context, (service, tenant) =>
          service.read.pool(tenant, {
            skuId: input.params.skuId,
            locationId: input.params.locationId,
            connectionId: input.params.connectionId,
            unit: input.query.unit,
          }),
        ),
      ),
    ),
    order: os.order.handler(async ({ context, input }) =>
      nativeOrderStockSchema.parse(
        await call(context, (service, tenant) =>
          service.read.order(tenant, input.params.orderId),
        ),
      ),
    ),
    allocate: os.allocate.handler(async ({ context, input }) =>
      nativeReservationResultSchema.parse(
        await call(context, (service, tenant) =>
          service.reservations.allocate(tenant, input.body),
        ),
      ),
    ),
    release: os.release.handler(async ({ context, input }) =>
      nativeReservationResultSchema.parse(
        await call(context, (service, tenant) =>
          service.reservations.release(tenant, input.body),
        ),
      ),
    ),
    consume: os.consume.handler(async ({ context, input }) =>
      nativeConsumptionResultSchema.parse(
        await call(context, (service, tenant) =>
          service.reservations.consumeVerified(tenant, input.body),
        ),
      ),
    ),
    shipments: os.shipments.handler(async ({ context, input }) =>
      nativeShipmentReadSchema.parse(
        await call(context, (service, tenant) =>
          service.readShipments(
            tenant,
            input.params.orderId,
            input.body.connectionId,
          ),
        ),
      ),
    ),
    ownershipReview: os.ownershipReview.handler(async ({ context, input }) =>
      nativeOwnershipReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ownership.get(tenant, input.params.reviewId),
        ),
      ),
    ),
    prepareOwnership: os.prepareOwnership.handler(async ({ context, input }) =>
      nativeOwnershipReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ownership.prepare(tenant, input.body),
        ),
      ),
    ),
    reviewOwnership: os.reviewOwnership.handler(async ({ context, input }) =>
      nativeOwnershipReviewSchema.parse(
        await call(context, (service, tenant) =>
          service.ownership.review(
            tenant,
            input.params.reviewId,
            input.body.approved,
          ),
        ),
      ),
    ),
    applyOwnership: os.applyOwnership.handler(async ({ context, input }) =>
      nativeScopeSchema.parse(
        await call(context, (service, tenant) =>
          service.ownership.apply(tenant, input.params.reviewId),
        ),
      ),
    ),
    expire: os.expire.handler(async ({ context, input }) =>
      call(context, (service, tenant) =>
        service.reservations.expireDue(
          tenant,
          input.body.limit,
          input.body.orderId,
        ),
      ),
    ),
  });
}
