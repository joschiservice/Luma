import { createHash } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import {
  createReturnCases,
  type ReturnCaseDependencies,
} from './application/return-cases.js';
import { createReturnCaseStore } from './infrastructure/return-case-store.js';

export { createCommerceProjections } from './infrastructure/projections.js';

export { createOrderMetricReader } from './infrastructure/metrics.js';

export { orderStateQueries } from './infrastructure/order-state.js';

export { createOrderListRebuilder } from './infrastructure/list-projection.js';

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Derives a stable UUID (version 5 layout) from a name. */
function nameUuid(name: string) {
  const hex = createHash('sha256').update(`luma:orders:${name}`).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Composes return cases with orders storage and the audit log. Without a return system or
 * admission, cases still work and creating the return in the order's system reports why it is
 * unavailable.
 */
export function createReturnCaseService(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Pick<
    ReturnCaseDependencies,
    'system' | 'admission' | 'refreshContext' | 'principal'
  >,
) {
  return createReturnCases({
    ...deps,
    store: createReturnCaseStore(db, audit),
    digest,
    uuid: nameUuid,
    now: () => new Date(),
  });
}

export { creationAction } from './application/return-cases.js';

export type {
  CreationAdmission,
  CreationExecution,
  ReturnCases,
  ReturnConnection,
  ReturnOption,
  ReturnSystem,
  ReturnSystemResult,
} from './application/return-cases.js';

export type {
  CreationFailure,
  FoundReturn,
  ReturnCreation,
} from './domain/return-creations.js';
