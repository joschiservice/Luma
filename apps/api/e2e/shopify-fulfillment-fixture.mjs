import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { appScopes } from './app-scopes.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const gid = (kind, value = 1) => `gid://shopify/${kind}/${value}`;

/** Creates an isolated, installed Shopify store with real recovery services and deterministic provider responses. */
export async function recoveryFixture(t, origin = 'http://localhost:3000') {
  const originalFetch = globalThis.fetch;
  const fulfillment = {
    id: gid('FulfillmentOrder'),
    updatedAt: '2026-09-29T00:00:00Z',
    status: 'ON_HOLD',
    requestStatus: 'UNSUBMITTED',
    order: { id: gid('Order') },
    assignedLocation: { name: 'Tokyo', location: { id: gid('Location') } },
    supportedActions: [{ action: 'RELEASE_HOLD' }],
    fulfillmentHolds: [1, 2].map((value) => ({
      id: gid('FulfillmentHold', value),
      reason: 'OTHER',
      heldByRequestingApp: true,
    })),
    lineItems: {
      nodes: [
        {
          lineItem: { id: gid('LineItem') },
          remainingQuantity: 2,
          totalQuantity: 2,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const mutations = [];
  let uncertain = false;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://recovery.myshopify.com/'))
      return originalFetch(url, init);
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('VerifyInstallation'))
      return Response.json({
        data: {
          shop: { myshopifyDomain: 'recovery.myshopify.com' },
          currentAppInstallation: {
            accessScopes: [
              'read_orders',
              'read_merchant_managed_fulfillment_orders',
              'write_merchant_managed_fulfillment_orders',
            ].map((handle) => ({ handle })),
          },
        },
      });
    if (query.startsWith('mutation')) {
      mutations.push(variables);
      if (uncertain) throw new Error('Lost provider response');
      assert.deepEqual(variables.holdIds, [gid('FulfillmentHold', 1)]);
      fulfillment.fulfillmentHolds = fulfillment.fulfillmentHolds.filter(
        (hold) => !variables.holdIds.includes(hold.id),
      );
      fulfillment.updatedAt = '2026-09-29T00:01:00Z';

      return Response.json({
        data: {
          result: {
            resultOrder: { id: fulfillment.id, order: fulfillment.order },
            userErrors: [],
          },
        },
      });
    }

    return Response.json({ data: { node: fulfillment } });
  };
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const f = await settingsFixture(t, origin, {
    connections: {
      activeKeyId: 'test',
      keys: new Map([['test', randomBytes(32)]]),
    },
  });
  await f.db.owner.query(
    `GRANT luma_connectors TO "${new URL(f.db.runtimeUrl).username}"`,
  );
  const admin = await f.signup('Approver');
  await f.request(
    f.owner,
    `${f.base}/members`,
    'POST',
    { userId: admin.id, roleId: 'admin' },
    201,
  );
  await f.request(f.owner, `${f.base}/apps/shopify/install`, 'POST', {
    version: null,
    scopes: appScopes.shopify,
  });
  const installed = await f.request(
    f.owner,
    `${f.base}/connections`,
    'POST',
    {
      label: 'Recovery store',
      target: { kind: 'shopify', shop: 'recovery.myshopify.com' },
      permissions: [
        'orders.read',
        'fulfillment.read',
        'fulfillment.hold.release',
        'fulfillment.open',
        'fulfillment.move',
      ],
      credentials: { token: 'test-token' },
    },
    201,
  );
  await f.request(
    f.owner,
    `${f.base}/connections/${installed.id}/check`,
    'POST',
    { version: installed.version },
  );

  return {
    f,
    admin,
    installed,
    fulfillment,
    mutations,
    loseResponse: () => {
      uncertain = true;
    },
  };
}
