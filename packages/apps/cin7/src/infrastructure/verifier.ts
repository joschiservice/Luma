import {
  ConnectorError,
  type InstallationCapability,
  type InstallationDependencies,
  type InstalledConnection,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import { createClient, parse, type RequestPacer } from '@luma/connector-cin7';
import * as s from '@luma/connector-cin7/schemas';
import type { z } from 'zod';

import { installationTarget } from '../domain/installation-validation.js';

const probes: {
  path: string;
  key: string;
  schema: z.ZodTypeAny;
  capabilities: InstallationCapability[];
}[] = [
  {
    path: 'saleList',
    key: 'SaleList',
    schema: s.saleListItem,
    capabilities: ['orders.read', 'fulfillment.read'],
  },
  {
    path: 'saleCreditNoteList',
    key: 'SaleList',
    schema: s.creditNoteListItem,
    capabilities: ['returns.read'],
  },
  {
    path: 'product',
    key: 'Products',
    schema: s.product,
    capabilities: ['products.read'],
  },
  {
    path: 'ref/productavailability',
    key: 'ProductAvailabilityList',
    schema: s.availability,
    capabilities: ['inventory.read'],
  },
  {
    path: 'customer',
    key: 'CustomerList',
    schema: s.customer,
    capabilities: ['customers.read'],
  },
  {
    path: 'supplier',
    key: 'SupplierList',
    schema: s.supplier,
    capabilities: ['suppliers.read'],
  },
  {
    path: 'purchaseList',
    key: 'PurchaseList',
    schema: s.purchaseListItem,
    capabilities: ['purchase-orders.read'],
  },
];

/**
 * Verifies the account and its readable endpoints with one-record probes. A Cin7 API
 * application can read the whole account, so a missing grant usually means an endpoint the
 * account's plan doesn't include.
 */
export function createInstallationVerifier(options: {
  fetch?: typeof globalThis.fetch | undefined;
  simulation?: SimulationTransport | undefined;
  /** The connection's shared request pacer. */
  pacer(connection: InstalledConnection): RequestPacer;
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = installationTarget.parse(connection.target);
    const transport =
      simulationTransport(connection, options.simulation) ?? options.fetch;
    const client = createClient({
      connection: {
        accountId: target.accountId,
        applicationKey: async () => credentials.token,
      },
      pacer: options.pacer(connection),
      ...(transport ? { fetch: transport } : {}),
    });
    // Rejected credentials fail here, before any grant is recorded.
    parse(s.me, await client.request('me'));

    async function readable(probe: (typeof probes)[number]) {
      try {
        const page = parse(
          s.page(probe.key, probe.schema),
          await client.request(probe.path, { Page: '1', Limit: '1' }),
        );
        if (page.items.length > Math.min(1, page.total))
          throw new Error('Invalid Cin7 verification response');

        return true;
      } catch (error) {
        if (
          !(error instanceof ConnectorError) ||
          !['permission_denied', 'not_found'].includes(error.failure.code)
        )
          throw error;

        return false;
      }
    }

    const granted: InstallationCapability[] = [];
    for (const probe of probes) {
      const wanted = probe.capabilities.filter((c) =>
        connection.permissions.includes(c),
      );
      if (wanted.length && (await readable(probe))) granted.push(...wanted);
    }

    return granted;
  };
}
