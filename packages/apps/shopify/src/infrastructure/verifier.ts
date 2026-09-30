import {
  type InstallationCapability,
  type InstallationDependencies,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import {
  createClient as shopifyClient,
  parse as shopifyParse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import { installationTarget } from './installation-validation.js';

/** Verifies account identity and grants using app-owned provider probes. */
export function createInstallationVerifier(options: {
  fetch?: typeof globalThis.fetch;
  simulation?: SimulationTransport | undefined;
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = installationTarget.parse(connection.target);
    const simulated = simulationTransport(connection, options.simulation);

    const client = shopifyClient({
      shop: target.shop,
      accessToken: async () => credentials.token,
      ...((simulated ?? options.fetch)
        ? { fetch: simulated ?? options.fetch }
        : {}),
    });
    const data = shopifyParse(
      z.object({
        shop: z.object({ myshopifyDomain: z.string() }),
        currentAppInstallation: z.object({
          accessScopes: z.array(z.object({ handle: z.string() })),
        }),
      }),
      await client(
        'query VerifyInstallation { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } }',
        {},
      ),
    );
    if (data.shop.myshopifyDomain !== target.shop)
      throw new Error('Shopify account does not match');
    const scopes = new Set(
      data.currentAppInstallation.accessScopes.map((s) => s.handle),
    );
    const has = (scope: string) =>
      scopes.has(`read_${scope}`) || scopes.has(`write_${scope}`);
    const granted: InstallationCapability[] = [];
    if (has('orders')) granted.push('orders.read');
    if (has('products')) granted.push('products.read');
    if (has('inventory')) granted.push('inventory.read');
    if (scopes.has('write_inventory'))
      granted.push('inventory.available.reconcile');
    if (has('customers')) granted.push('customers.read');
    if (has('orders') && has('returns')) granted.push('returns.read');
    if (
      has('orders') &&
      [
        'merchant_managed_fulfillment_orders',
        'assigned_fulfillment_orders',
        'third_party_fulfillment_orders',
      ].some(has)
    )
      granted.push('fulfillment.read');

    if (
      has('orders') &&
      [
        'write_merchant_managed_fulfillment_orders',
        'write_third_party_fulfillment_orders',
      ].some((scope) => scopes.has(scope))
    ) {
      granted.push(
        'fulfillment.hold.release',
        'fulfillment.open',
        'fulfillment.move',
      );
    }

    return granted;
  };
}
