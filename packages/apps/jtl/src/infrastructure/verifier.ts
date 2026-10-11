import {
  ConnectorError,
  type InstallationCapability,
  type InstallationDependencies,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import {
  createClient as jtlClient,
  parse as jtlParse,
} from '@luma/connector-jtl';
import { z } from 'zod';

import {
  type ApprovedJtlEndpoint,
  approvedJtlFetch,
} from './approved-jtl-fetch.js';
import { installationTarget } from './installation-validation.js';
import * as jtl from './schemas.js';

/** Verifies account identity and grants using app-owned provider probes. */
export function createInstallationVerifier(options: {
  fetch?: typeof globalThis.fetch;
  simulation?: SimulationTransport | undefined;
  jtlEndpoints: readonly ApprovedJtlEndpoint[];
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = installationTarget.parse(connection.target);
    const simulated = simulationTransport(connection, options.simulation);
    let transport = simulated ?? options.fetch;
    if (target.kind === 'jtl-onprem' && !simulated) {
      const endpoint = options.jtlEndpoints.find(
        (e) =>
          e.tenantId === connection.tenantId && e.baseUrl === target.baseUrl,
      );
      if (!endpoint) throw new Error('JTL destination is not approved');
      // Production always uses the pinned transport; the injected transport is only for provider contract tests.
      transport ??= approvedJtlFetch(endpoint);
    }
    const client = jtlClient({
      connection:
        target.kind === 'jtl-cloud'
          ? {
              kind: 'cloud',
              jtlTenantId: target.jtlTenantId,
              accessToken: async () => credentials.token,
            }
          : {
              kind: 'onprem',
              baseUrl: target.baseUrl,
              appId: target.appId,
              appVersion: target.appVersion,
              challengeCode: z.string().parse(credentials.challengeCode),
              apiKey: async () => credentials.token,
            },
      ...(transport ? { fetch: transport } : {}),
    });
    const granted: InstallationCapability[] = [];
    const probes: {
      path: string;
      schema: z.ZodTypeAny;
      capabilities: InstallationCapability[];
      /** A plain-array list the capabilities also read. */
      list?: { path: string; schema: z.ZodTypeAny };
    }[] = [
      {
        path: 'sales-orders',
        schema: jtl.order,
        capabilities: ['orders.read'],
      },
      {
        path: 'items',
        schema: jtl.item,
        capabilities: ['products.read', 'inventory.read'],
      },
      {
        path: 'delivery-notes',
        schema: jtl.note,
        capabilities: ['fulfillment.read'],
      },
      {
        path: 'customers',
        schema: jtl.customer,
        capabilities: ['customers.read'],
      },
      {
        path: 'suppliers',
        schema: jtl.supplier,
        capabilities: ['suppliers.read'],
      },
      {
        path: 'purchase-orders',
        schema: jtl.purchaseOrderListItem,
        capabilities: ['purchase-orders.read'],
      },
      {
        path: 'warehouses',
        schema: jtl.warehouse,
        capabilities: ['returns.options.read'],
        list: { path: 'return-reasons', schema: jtl.returnReason },
      },
      {
        path: 'returns',
        schema: jtl.returnRow,
        capabilities: ['returns.created.read'],
      },
    ];

    // Reads one overview page, or a whole plain-array list; missing grants or endpoints mean
    // the capability stays unavailable.
    async function readable(path: string, schema: z.ZodTypeAny, list = false) {
      try {
        if (list) {
          jtlParse(z.array(schema), await client.request(path));

          return true;
        }
        const page = jtlParse(
          jtl.page(schema),
          await client.request(path, { pageNumber: '1', pageSize: '1' }),
        );
        if (
          page.pageNumber !== 1 ||
          page.pageSize !== 1 ||
          page.items.length !== Math.min(1, page.totalItems)
        )
          throw new Error('Invalid JTL verification response');

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

    for (const probe of probes) {
      if (!probe.capabilities.some((c) => connection.permissions.includes(c)))
        continue;
      if (
        (await readable(probe.path, probe.schema)) &&
        (!probe.list ||
          (await readable(probe.list.path, probe.list.schema, true)))
      )
        granted.push(...probe.capabilities);
    }

    // Local synthetic bindings have known write grants; live read probes cannot establish them.
    if (simulated && granted.includes('orders.read'))
      granted.push(
        'orders.shipping-method.read',
        'orders.shipping-method.write',
      );
    // Submission prices lines from item supplier assignments, so it also needs item reads.
    if (
      simulated &&
      connection.permissions.includes('purchase-orders.submit') &&
      granted.includes('purchase-orders.read') &&
      (await readable('items', jtl.item))
    )
      granted.push('purchase-orders.submit');
    // Creation checks the sales order and finds earlier returns, so it needs all three reads.
    if (
      simulated &&
      connection.permissions.includes('returns.create') &&
      granted.includes('returns.options.read') &&
      granted.includes('returns.created.read') &&
      (await readable('sales-orders', jtl.order))
    )
      granted.push('returns.create');

    return granted;
  };
}
