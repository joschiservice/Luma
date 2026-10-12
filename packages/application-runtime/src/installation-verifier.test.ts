import type { InstalledConnection } from '@luma/connections';
import { describe, expect, it, vi } from 'vitest';

import { createInstallationVerifier } from './test-support/apps.js';

const connection: InstalledConnection = {
  id: 'connection',
  tenantId: 'tenant',
  label: 'Store',
  target: { kind: 'shopify', shop: 'example.myshopify.com' },
  permissions: [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
  ],
  granted: [],
  status: 'pending',
  version: 1,
  credentialVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const credentials = { token: 'private-token', challengeCode: 'challenge' };

const shopify = (scopes: string[], shop = 'example.myshopify.com') => ({
  data: {
    shop: { myshopifyDomain: shop },
    currentAppInstallation: {
      accessScopes: scopes.map((handle) => ({ handle })),
    },
  },
});

const page = { items: [], pageNumber: 1, pageSize: 1, totalItems: 0 };

describe('provider installation verification', () => {
  it('binds Shopify to its shop and uses provider scopes rather than requested permissions', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(shopify(['read_products', 'read_inventory'])),
      );
    const verify = createInstallationVerifier({ fetch, jtlEndpoints: [] });
    expect(await verify(connection, credentials)).toEqual([
      'products.read',
      'inventory.read',
      'returns.exchange.options.read',
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    fetch.mockResolvedValueOnce(
      Response.json(
        shopify(['write_orders', 'read_merchant_managed_fulfillment_orders']),
      ),
    );
    expect(await verify(connection, credentials)).toEqual([
      'orders.read',
      'returns.settlement.quote.read',
      'returns.settlement.proof.read',
      'returns.refund',
      'fulfillment.read',
    ]);
    fetch.mockResolvedValueOnce(Response.json(shopify(['read_orders'])));
    expect(await verify(connection, credentials)).toEqual([
      'orders.read',
      'returns.settlement.quote.read',
      'returns.settlement.proof.read',
    ]);
    fetch.mockResolvedValueOnce(
      Response.json(shopify(['read_orders'], 'foreign.myshopify.com')),
    );
    await expect(verify(connection, credentials)).rejects.toThrow(
      'does not match',
    );
  });
  it.each([401, 403, 429, 500])(
    'does not grant access on Shopify HTTP %s',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('provider secret', { status }));
      await expect(
        createInstallationVerifier({ fetch, jtlEndpoints: [] })(
          connection,
          credentials,
        ),
      ).rejects.toThrow();
    },
  );
  it('rejects malformed and partial GraphQL responses', async () => {
    for (const body of [
      { data: {} },
      {
        ...shopify(['read_orders']),
        errors: [{ extensions: { code: 'ACCESS_DENIED' } }],
      },
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json(body));
      await expect(
        createInstallationVerifier({ fetch, jtlEndpoints: [] })(
          connection,
          credentials,
        ),
      ).rejects.toThrow();
    }
  });
  it('probes authenticated JTL reads with the bound tenant and never grants writes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(page),
    );
    const verify = createInstallationVerifier({ fetch, jtlEndpoints: [] });
    const target = {
      kind: 'jtl-cloud' as const,
      jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    };
    const granted = await verify(
      {
        ...connection,
        target,
        permissions: [
          ...connection.permissions,
          'orders.shipping-method.read',
          'orders.shipping-method.write',
        ],
      },
      credentials,
    );
    expect(granted).toEqual(connection.permissions);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toContain('https://api.jtl-cloud.com/erp/v2/');
      expect(String(url)).toContain('pageSize=1');
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer private-token',
          'X-Tenant-ID': target.jtlTenantId,
        },
      });
    }
  });
  it('omits denied JTL permissions and rejects invalid credentials or malformed responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes('items?')
        ? new Response(null, { status: 403 })
        : Response.json(page),
    );
    const verify = createInstallationVerifier({ fetch, jtlEndpoints: [] });
    const value = {
      ...connection,
      target: {
        kind: 'jtl-cloud' as const,
        jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      },
    };
    expect(await verify(value, credentials)).toEqual([
      'orders.read',
      'fulfillment.read',
    ]);
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(verify(value, credentials)).rejects.toThrow();
    fetch.mockResolvedValueOnce(Response.json({ ...page, totalItems: 5 }));
    await expect(verify(value, credentials)).rejects.toThrow();
  });
  it('requires an exact tenant-specific on-premise approval before sending credentials', async () => {
    const target = {
      kind: 'jtl-onprem' as const,
      baseUrl: 'https://erp.example.test/api/company/',
      appId: 'luma',
      appVersion: '1',
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(page),
    );
    const verify = createInstallationVerifier({
      fetch,
      jtlEndpoints: [
        {
          tenantId: 'tenant',
          baseUrl: target.baseUrl,
          addresses: ['10.0.0.5'],
        },
      ],
    });
    await expect(
      verify({ ...connection, target, tenantId: 'foreign' }, credentials),
    ).rejects.toThrow('not approved');
    await expect(
      verify(
        {
          ...connection,
          target: { ...target, baseUrl: 'https://erp.example.test/api/other/' },
        },
        credentials,
      ),
    ).rejects.toThrow('not approved');
    expect(fetch).not.toHaveBeenCalled();
    expect(await verify({ ...connection, target }, credentials)).toEqual(
      connection.permissions,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Wawi private-token',
        'x-appid': 'luma',
        'x-challengecode': 'challenge',
      },
    });
  });
});

it.each([
  ['read_products', 'products.read'],
  ['read_inventory', 'inventory.read'],
])('maps Shopify %s independently', async (scope, capability) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(shopify([scope])));
  expect(
    await createInstallationVerifier({ fetch, jtlEndpoints: [] })(
      connection,
      credentials,
    ),
  ).toEqual([capability]);
});
