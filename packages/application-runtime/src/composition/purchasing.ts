import { createHash } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  createPurchaseIncoming,
  createPurchaseIncomingStore,
} from '@luma/inventory/composition';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';
import {
  createIncomingStock,
  createIncomingStockReader,
  createProcurement,
  createSupplierTerms,
} from '@luma/procurement/composition';
import { readNativePurchaseIncoming } from '@luma/read-models/composition';

import type { createTenantFeatureRelease } from './feature-release.js';

/**
 * Composes the purchasing owners that depend on no action controls: purchase orders, supplier
 * terms and incoming stock. `projectIncoming` reconciles an order's native incoming stock;
 * procurement, supplier commitments and order changes call it when an order changes. Incoming
 * stock and supplier terms answer only for tenants with their release.
 */
export function createPurchasingServices(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext'>;
  release: ReturnType<typeof createTenantFeatureRelease>;
}): {
  incoming: ReturnType<typeof createIncomingStock>;
  procurement: ReturnType<typeof createProcurement>;
  projectIncoming: (context: TenantContext, orderId: string) => Promise<void>;
  supplierTerms: ReturnType<typeof createSupplierTerms>;
} {
  const { database, identity, release } = options;
  const nativeIncomingHash = (value: unknown) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const nativeIncoming = createPurchaseIncoming({
    store: createPurchaseIncomingStore(
      database,
      createAuditLog,
      readNativePurchaseIncoming,
    ),
    refreshContext: identity.refreshContext,
    enabled: (context) => release(context.tenantId, 'purchasing-incoming'),
    hash: nativeIncomingHash,
    uuid: (key) => {
      const hex = nativeIncomingHash(key);

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  });
  const projectIncoming = async (context: TenantContext, orderId: string) => {
    await nativeIncoming.reconcile(context, orderId);
  };
  const incoming = createIncomingStock({
    refreshContext: identity.refreshContext,
    enabled: (context) => release(context.tenantId, 'purchasing-incoming'),
    read: createIncomingStockReader(database),
    now: () => new Date(),
  });
  const supplierTerms = createSupplierTerms(
    database,
    identity.refreshContext,
    createAuditLog,
    (context) => release(context.tenantId, 'supplier-purchasing-terms'),
  );
  const procurement = createProcurement(
    database,
    identity.refreshContext,
    createAuditLog,
    projectIncoming,
  );

  return { incoming, procurement, projectIncoming, supplierTerms };
}
