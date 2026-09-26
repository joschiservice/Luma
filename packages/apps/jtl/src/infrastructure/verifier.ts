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
    ];
    for (const probe of probes) {
      if (!probe.capabilities.some((c) => connection.permissions.includes(c)))
        continue;
      try {
        const page = jtlParse(
          jtl.page(probe.schema),
          await client.request(probe.path, { pageNumber: '1', pageSize: '1' }),
        );
        if (
          page.pageNumber !== 1 ||
          page.pageSize !== 1 ||
          page.items.length !== Math.min(1, page.totalItems)
        )
          throw new Error('Invalid JTL verification response');
        granted.push(...probe.capabilities);
      } catch (error) {
        if (
          !(error instanceof ConnectorError) ||
          !['permission_denied', 'not_found'].includes(error.failure.code)
        )
          throw error;
      }
    }

    // Local synthetic bindings have known write grants; live read probes cannot establish them.
    if (simulated && granted.includes('orders.read'))
      granted.push(
        'orders.shipping-method.read',
        'orders.shipping-method.write',
      );

    return granted;
  };
}
