import { createHash } from 'node:crypto';

import type { InstalledConnection } from '@luma/connections';
import {
  type BudgetStore,
  createReadBudget,
  createSharedReadBudget,
  type ReadBudget,
  type RequestPurpose,
} from '@luma/connector-shopify';

/** Builds a trusted app/shop budget; reconnects and token rotation retain the same opaque key. */
export function shopifyRequestBudget(
  options: {
    requestBudgetStore?: BudgetStore | undefined;
    env?: Readonly<Record<string, string | undefined>>;
  },
  connection: Pick<InstalledConnection, 'tenantId' | 'target'>,
  purpose: RequestPurpose = 'foreground',
  region = 'EU',
): ReadBudget {
  if (!options.requestBudgetStore) return createReadBudget();
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        region,
        connection.tenantId,
        options.env?.SHOPIFY_APP_ENVIRONMENT ?? 'manual',
        options.env?.SHOPIFY_CLIENT_ID ?? 'manual',
        connection.target.shop,
      ]),
    )
    .digest('hex');

  return createSharedReadBudget({
    store: options.requestBudgetStore,
    key: `luma:shopify:admission:v1:{${binding}}`,
    purpose,
    maxWaitMs: purpose === 'foreground' ? 2000 : 0,
    continuationWaitMs: purpose === 'foreground' ? 2000 : 10000,
  });
}
