import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createProcurementService } from './application/procurement.js';
import { createProcurementStore } from './infrastructure/store.js';
import {
  purchaseOrderInputSchema,
  supplierInputSchema,
  transitionInputSchema,
} from './infrastructure/validation.js';

/** Composes authoritative procurement storage with refreshed membership and transactional audit. */
export function createProcurement(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  audit: (db: TenantDatabase) => AuditLog,
) {
  return createProcurementService({
    store: createProcurementStore(db, audit),
    parseSupplier: (input) => supplierInputSchema.parse(input),
    parseOrder: (input) => purchaseOrderInputSchema.parse(input),
    parseTransition: (input) => transitionInputSchema.parse(input),
    refreshContext,
    now: () => new Date(),
    id: randomUUID,
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
}
