import { createAuditLog } from '@luma/audit/composition';
import type { IdentityService } from '@luma/identity';
import type { LedgerService } from '@luma/inventory';
import {
  createLedgerService,
  createLedgerStore,
} from '@luma/inventory/composition';
import type { TenantDatabase } from '@luma/platform';

/** Composes the shadow ledger with current identity checks and atomic Inventory audit; no provider writer is installed. */
export function createInventoryLedgerRuntime(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
): LedgerService {
  return createLedgerService({
    store: createLedgerStore(db, createAuditLog),
    refreshContext: identity.refreshContext,
    reviewerContext: (tenant, user, request) =>
      identity.resolveWorkflowContext(user, tenant, request),
  });
}
