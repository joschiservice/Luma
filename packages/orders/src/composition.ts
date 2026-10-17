import { createHash } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import { createReturnActions } from './application/return-actions.js';
import {
  createReturnCases,
  type ReturnCaseDependencies,
} from './application/return-cases.js';
import { createReturnDeadlines } from './application/return-deadlines.js';
import { createReturnExchanges } from './application/return-exchanges.js';
import { createReturnActionStore } from './infrastructure/return-action-store.js';
import { createReturnCaseStore } from './infrastructure/return-case-store.js';
import { createReturnDeadlineStore } from './infrastructure/return-deadline-store.js';
import { createReturnExchangeStore } from './infrastructure/return-exchange-store.js';

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

export type {
  CreationAdmission,
  CreationExecution,
  ReturnCases,
  ReturnOption,
  ReturnSystem,
  ReturnSystemResult,
} from './application/return-cases.js';

export type { FoundReturn } from './domain/return-creations.js';

/** Composes governed settlement with orders-owned storage and audited provider ports. */
export function createReturnActionService(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Omit<
    Parameters<typeof createReturnActions>[0],
    'store' | 'cases' | 'digest' | 'uuid' | 'now'
  >,
) {
  return createReturnActions({
    ...deps,
    store: createReturnActionStore(db, audit),
    cases: createReturnCaseStore(db, audit),
    digest,
    uuid: nameUuid,
    now: () => new Date(),
  });
}

export type {
  ReturnActions,
  ReturnSettlementSystem,
  ReturnSettlementAdmission,
} from './application/return-actions.js';

/** Composes exchange coordination with tenant-owned persistence and independently governed source effects. */
export function createReturnExchangeService(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Omit<
    Parameters<typeof createReturnExchanges>[0],
    'store' | 'cases' | 'digest' | 'uuid' | 'now'
  >,
) {
  return createReturnExchanges({
    ...deps,
    store: createReturnExchangeStore(db, audit),
    cases: createReturnCaseStore(db, audit),
    digest,
    uuid: nameUuid,
    now: () => new Date(),
  });
}

export type {
  ReturnExchanges,
  ReturnExchangeSystem,
  ReturnExchangeAdmission,
} from './application/return-exchanges.js';

/** Composes tenant-owned deadline configuration and durable waiting, with read-only source evidence. */
export function createReturnDeadlineService(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
  deps: Omit<
    Parameters<typeof createReturnDeadlines>[0],
    'store' | 'uuid' | 'digest' | 'now'
  > & { now?: () => Date },
) {
  return createReturnDeadlines({
    ...deps,
    store: createReturnDeadlineStore(db, audit),
    digest,
    uuid: nameUuid,
    now: deps.now ?? (() => new Date()),
  });
}

export type { ReturnDeadlines } from './application/return-deadlines.js';

export { createReturnMoneySource } from './application/return-money-source.js';
