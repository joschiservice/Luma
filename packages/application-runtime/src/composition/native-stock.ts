import { createShopifyUnsettledStockReader } from '@luma/app-shopify';
import { createAuditLog } from '@luma/audit/composition';
import type { AuthorityReader, CapabilityReader } from '@luma/connections';
import { createUnsettledStockEffectReader } from '@luma/execution/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { NativeStockRuntime } from '@luma/inventory';
import { LedgerError } from '@luma/inventory';
import {
  createNativeShipmentReader,
  createNativeStockReader,
  createNativeStockServices,
  createNativeStockSourceReader,
  createNativeStockStore,
} from '@luma/inventory/composition';
import type { TenantDatabase } from '@luma/platform';

import { createInventoryLedgerRuntime } from './inventory-ledger.js';
import { createSalesRuntime } from './sales.js';
import { createCommerceServices } from './services.js';

/** Shares owner transactions for native stock, Sales demand and fresh authority; it installs no provider writer. */
export function createNativeStockRuntime(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
  enabled: (context: TenantContext) => Promise<boolean>,
  authority: (db: TenantDatabase) => AuthorityReader,
  reader?: CapabilityReader,
): NativeStockRuntime {
  const store = createNativeStockStore(db, createAuditLog, {
    demand: (scoped, context, orderId, requireAuthority) =>
      createSalesRuntime(scoped, identity, enabled, authority).stockDemand(
        context,
        orderId,
        requireAuthority,
      ),
    authorityRevision: async (scoped, context) =>
      (await authority(scoped).read(context)).revision,
    unsettled: async (scoped, context, connectionId) => {
      const [stock, generic] = await Promise.all([
        createShopifyUnsettledStockReader(scoped)(context, connectionId),
        createUnsettledStockEffectReader(scoped)(context, connectionId),
      ]);

      return stock || generic;
    },
  });
  const readShipments = reader
    ? createNativeShipmentReader({
        db,
        store,
        reader,
        refreshContext: identity.refreshContext,
        record: async (context, observations) => {
          const commerce = createCommerceServices(db);
          const outcomes = await commerce.ingestion.importMany(
            context,
            observations.map((observation) => ({
              ingestKey: observation.id,
              input: { capability: 'fulfillment.read' as const, observation },
            })),
          );
          if (outcomes.some((outcome) => outcome.status === 'pending'))
            throw new LedgerError(
              'source_incomplete',
              'Shipment observations remain incompletely mapped.',
            );
        },
      })
    : async () => {
        throw new LedgerError(
          'source_incomplete',
          'Shipment reads are unavailable in this runtime.',
        );
      };

  const readStock = reader
    ? createNativeStockSourceReader({
        db,
        store,
        reader,
        refreshContext: identity.refreshContext,
        record: async (context, observations) => {
          const outcomes = await createCommerceServices(
            db,
          ).ingestion.importMany(
            context,
            observations.map((observation) => ({
              ingestKey: observation.id,
              input: { capability: 'inventory.read' as const, observation },
            })),
          );
          if (outcomes.some((outcome) => outcome.status === 'pending'))
            throw new LedgerError(
              'source_incomplete',
              'Stock observations remain incompletely mapped.',
            );
        },
      })
    : async () => {
        throw new LedgerError(
          'source_incomplete',
          'Independent stock reads are unavailable in this runtime.',
        );
      };

  return {
    readStock,
    store,
    ledger: createInventoryLedgerRuntime(db, identity),
    readShipments,
    read: createNativeStockReader(
      db,
      identity.refreshContext,
      (scoped, context, orderId) =>
        createSalesRuntime(scoped, identity, enabled, authority).stockDemand(
          context,
          orderId,
          false,
        ),
    ),
    ...createNativeStockServices({
      store,
      refreshContext: identity.refreshContext,
      reviewerContext: (tenant, user, request) =>
        identity.resolveWorkflowContext(user, tenant, request),
    }),
  };
}
