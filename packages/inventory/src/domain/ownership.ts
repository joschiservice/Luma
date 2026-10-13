import { LedgerError } from './ledger.js';

/** Native authority is an explicit location transition; workspace defaults alone never confer it. */
export type StockOwnershipMode = 'observe' | 'shadow' | 'propose' | 'own';

/** A reviewed transition binds every stock pool, source mapping and reservation version in its location scope. */
export interface OwnershipBinding {
  authorityRevision: number;
  scopeVersion: string;
  connectionId: string;
  locationId: string;
  pools: {
    skuId: string;
    unit: string;
    openingReviewId: string;
    comparisonId: string | null;
    /** Fresh storage alignment for handback is distinct from physical drift verification. */
    channelHandover?: { snapshotId: string; meaningHash: string } | undefined;
    mappingVersion: string;
    accountVersions: { id: string; version: string }[];
  }[];
  reservationVersions: { id: string; version: string }[];
}

/** Checks the deliberate forward path and audited handback; all other shortcuts are rejected. */
export function requireOwnershipTransition(
  from: StockOwnershipMode,
  to: StockOwnershipMode,
) {
  const forward =
    (from === 'observe' && to === 'shadow') ||
    (from === 'shadow' && to === 'propose') ||
    (from === 'propose' && to === 'own');
  const handback =
    (from === 'own' || from === 'propose' || from === 'shadow') &&
    to === 'observe';
  if (!forward && !handback)
    throw new LedgerError(
      'invalid_entry',
      'Use the explicit observe, shadow, propose and own sequence or an audited handback.',
    );
}

/** Allocation may exercise the native shadow model; dispatch to providers still requires a separate controlled publisher. */
export function requireAllocationMode(mode: StockOwnershipMode) {
  if (mode === 'observe')
    throw new LedgerError(
      'review_required',
      'Start the reviewed shadow ledger before allocating native stock.',
    );
}
