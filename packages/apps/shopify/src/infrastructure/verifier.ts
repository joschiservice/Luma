import {
  type InstallationCapability,
  type InstallationDependencies,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import {
  type BudgetStore,
  createClient as shopifyClient,
  parse as shopifyParse,
} from '@luma/connector-shopify';
import { z } from 'zod';

import { installationTarget } from './installation-validation.js';
import { shopifyRequestBudget } from './request-budget.js';

/** Verifies account identity and grants using app-owned provider probes. */
export function createInstallationVerifier(options: {
  fetch?: typeof globalThis.fetch;
  simulation?: SimulationTransport | undefined;
  requestBudgetStore?: BudgetStore | undefined;
  env?: Readonly<Record<string, string | undefined>>;
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = installationTarget.parse(connection.target);
    const simulated = simulationTransport(connection, options.simulation);

    const client = shopifyClient({
      budget: shopifyRequestBudget(options, connection),
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
    if (has('orders'))
      granted.push(
        'orders.read',
        'returns.settlement.quote.read',
        'returns.settlement.proof.read',
      );
    if (scopes.has('write_orders')) granted.push('returns.refund');
    if (has('products')) granted.push('products.read');
    if (has('inventory')) granted.push('inventory.read');
    if (has('inventory_transfers')) granted.push('inventory.transfers.read');
    if (has('inventory_shipments')) granted.push('inventory.shipments.read');
    if (scopes.has('write_inventory'))
      granted.push('inventory.available.reconcile');
    if (has('customers')) granted.push('customers.read');
    if (has('orders') && has('returns')) granted.push('returns.read');
    if (has('orders') && has('returns'))
      granted.push('returns.options.read', 'returns.created.read');
    if (has('orders') && scopes.has('write_returns'))
      granted.push('returns.create');
    if (has('products') && has('inventory'))
      granted.push('returns.exchange.options.read');
    if (has('orders') && has('returns') && has('products') && has('inventory'))
      granted.push(
        'returns.exchange.quote.read',
        'returns.exchange.proof.read',
        'returns.exchange.price.read',
      );
    if (
      has('orders') &&
      has('products') &&
      has('inventory') &&
      scopes.has('write_returns')
    )
      granted.push(
        'returns.exchange.request',
        'returns.exchange.process',
        'returns.exchange.cancel',
      );
    if (
      has('orders') &&
      [
        'merchant_managed_fulfillment_orders',
        'assigned_fulfillment_orders',
        'third_party_fulfillment_orders',
      ].some(has)
    )
      granted.push('fulfillment.read');
    // Edits are checked against fulfillment work first, so they need fulfillment reads too.
    if (granted.includes('fulfillment.read') && scopes.has('write_order_edits'))
      granted.push('orders.quantity.edit');

    if (
      has('orders') &&
      [
        'write_merchant_managed_fulfillment_orders',
        'write_third_party_fulfillment_orders',
      ].some((scope) => scopes.has(scope))
    ) {
      granted.push(
        'returns.exchange.release',
        'fulfillment.hold.release',
        'fulfillment.open',
        'fulfillment.move',
        'fulfillment.shipment.create',
        'fulfillment.tracking.update',
      );
    }

    return granted;
  };
}
