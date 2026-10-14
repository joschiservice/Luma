import { describe, expect, it } from 'vitest';

import { shopifyRequestBudget } from './request-budget.js';

describe('trusted Shopify admission scopes', () => {
  it('retains scope through reconnects and separates tenant, region, app and shop bindings without storing secrets', async () => {
    const keys: string[] = [];
    const requestBudgetStore = {
      async run(_script: string, key: string) {
        keys.push(key);

        return [1, 0, Date.now() + 1000];
      },
    };
    const env = {
      SHOPIFY_CLIENT_ID: 'app-one',
      SHOPIFY_APP_ENVIRONMENT: 'test',
      SHOPIFY_CLIENT_SECRET: 'sensitive-app-secret',
    };
    const connection = {
      id: 'old-installation',
      tenantId: 'tenant-one',
      target: { kind: 'shopify' as const, shop: 'example.myshopify.com' },
    };
    const scope = async (bound = connection, settings = env, region = 'EU') => {
      const before = keys.length;
      await shopifyRequestBudget(
        { requestBudgetStore, env: settings },
        bound,
        'foreground',
        region,
      ).run('query', async (feedback) =>
        feedback.observe('query', 1, 1999, 100, 1, 2000),
      );

      return keys[before];
    };
    const initial = await scope();
    expect(await scope({ ...connection, id: 'reconnected-installation' })).toBe(
      initial,
    );
    expect(await scope({ ...connection, tenantId: 'tenant-two' })).not.toBe(
      initial,
    );
    expect(
      await scope({
        ...connection,
        target: { ...connection.target, shop: 'other.myshopify.com' },
      }),
    ).not.toBe(initial);
    expect(
      await scope(connection, { ...env, SHOPIFY_CLIENT_ID: 'app-two' }),
    ).not.toBe(initial);
    expect(await scope(connection, env, 'US')).not.toBe(initial);
    expect(
      keys.every((key) =>
        /^luma:shopify:admission:v1:\{[a-f0-9]{64}\}$/.test(key),
      ),
    ).toBe(true);
    expect(keys.join()).not.toContain(env.SHOPIFY_CLIENT_SECRET);
  });
});
