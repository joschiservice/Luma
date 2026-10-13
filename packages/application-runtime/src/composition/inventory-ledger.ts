import { createAuditLog } from '@luma/audit/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { LedgerService } from '@luma/inventory';
import {
  createLedgerService,
  createLedgerStore,
} from '@luma/inventory/composition';
import type { TenantDatabase } from '@luma/platform';

import { readNativePurchaseReceipt } from './native-purchase-receipts.js';

/** Composes the shadow ledger with current identity checks and atomic Inventory audit; no provider writer is installed. */
export function createInventoryLedgerRuntime(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
  purchaseReceiptsEnabled?: (context: TenantContext) => Promise<boolean>,
): LedgerService {
  return createLedgerService({
    store: createLedgerStore(db, createAuditLog, {
      purchaseReceipt: readNativePurchaseReceipt,
    }),
    ...(purchaseReceiptsEnabled ? { purchaseReceiptsEnabled } : {}),
    refreshContext: identity.refreshContext,
    reviewerContext: (tenant, user, request) =>
      identity.resolveWorkflowContext(user, tenant, request),
  });
}
