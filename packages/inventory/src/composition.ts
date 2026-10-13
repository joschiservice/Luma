import { createHash } from 'node:crypto';

import { canonicalJson } from '@luma/platform';

import type { LedgerDependencies } from './application/ledger.js';
import { createLedgerService as assembleLedger } from './application/ledger-service.js';
import type { NativeStockDependencies } from './application/native-stock.js';
import { createReservationService } from './application/reservations.js';
import { createStockOwnershipService } from './application/stock-ownership.js';
import { ledgerInputParser } from './infrastructure/ledger-validation.js';
import {
  parseAllocation,
  parseRelease,
} from './infrastructure/native-stock-validation.js';

export { createCommerceProjections } from './infrastructure/projections.js';

export { createLedgerStore } from './infrastructure/ledger-store.js';

/** Installs boundary validation and stable content hashing around Inventory application rules. */
export function createLedgerService(
  deps: Omit<LedgerDependencies, 'hash' | 'validation'>,
) {
  return assembleLedger({
    ...deps,
    hash: (value) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    validation: ledgerInputParser,
  });
}

export { createNativeStockStore } from './infrastructure/native-stock-store.js';

/** Composes native reservations and reviewed location transitions with boundary validation. */
export function createNativeStockServices(
  deps: Omit<NativeStockDependencies, 'hash' | 'allocation' | 'release'>,
) {
  const prepared = {
    ...deps,
    hash: (value: unknown) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    allocation: parseAllocation,
    release: parseRelease,
  };

  return {
    reservations: createReservationService(prepared),
    ownership: createStockOwnershipService(prepared),
  };
}

export { createNativeShipmentReader } from './infrastructure/native-shipment-reader.js';

export { createNativeStockReader } from './infrastructure/native-stock-reader.js';

export { createNativeStockSourceReader } from './infrastructure/native-stock-source-reader.js';

export { createNativePublicationFence } from './infrastructure/publication-fence.js';
