import { z } from 'zod';
import type { InstallationDependencies } from '../application/installations.js';
import type { InstallationCapability } from '../domain/installation.js';
import { ConnectorError } from '../domain/capabilities.js';
import {
  createClient as shopifyClient,
  parse as shopifyParse,
} from './shopify/client.js';
import { createClient as jtlClient, parse as jtlParse } from './jtl/client.js';
import * as jtl from './jtl/schemas.js';
import { approvedJtlFetch } from './approved-jtl-fetch.js';
import type { ApprovedJtlEndpoint } from './approved-jtl-fetch.js';

export function createInstallationVerifier(options: {
  jtlEndpoints: readonly ApprovedJtlEndpoint[];
  fetch?: typeof globalThis.fetch;
}): InstallationDependencies['verify'] {
  return async (connection, credentials) => {
    const target = connection.target;
    if (target.kind === 'shopify') {
      const client = shopifyClient({
        shop: target.shop,
        accessToken: async () => credentials.token,
        ...(options.fetch ? { fetch: options.fetch } : {}),
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
      if (
        has('orders') &&
        [
          'merchant_managed_fulfillment_orders',
          'assigned_fulfillment_orders',
          'third_party_fulfillment_orders',
        ].some(has)
      )
        granted.push('fulfillment.read');
      return granted;
    }
    let transport = options.fetch;
    if (target.kind === 'jtl-onprem') {
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
              challengeCode: credentials.challengeCode!,
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
    // Read probes cannot establish write grants or installation-specific idempotency behavior.
    return granted;
  };
}
