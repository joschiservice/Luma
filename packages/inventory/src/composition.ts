import { createHash } from 'node:crypto';

import { canonicalJson } from '@luma/platform';

import type { LedgerDependencies } from './application/ledger.js';
import { createLedgerService as assembleLedger } from './application/ledger-service.js';
import { ledgerInputParser } from './infrastructure/ledger-validation.js';

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
