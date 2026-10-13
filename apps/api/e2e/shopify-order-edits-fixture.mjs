import { randomBytes } from 'node:crypto';

import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { readOrder, shopify } from '@luma/simulator-shopify';

import { appScopes } from './app-scopes.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const config = {
  shop: 'edits.myshopify.com',
  name: 'Edits',
  currency: 'EUR',
  orderPrefix: 'E',
  locations: [{ id: '1', name: 'Simulator warehouse' }],
  scopes: [
    'read_orders',
    'read_products',
    'read_inventory',
    'read_merchant_managed_fulfillment_orders',
    'write_order_edits',
  ],
};

/**
 * Exercises real order edit, approval and execution services against an isolated Shopify
 * simulator. The transport records every mutation and can lose the commit's response after
 * Shopify applied it.
 */
export async function orderEditFixture(t, origin = 'http://localhost:3000') {
  const originalFetch = globalThis.fetch;
  const store = createMemoryStore();
  const context = () => ({
    store,
    now: Date.now(),
    wallTime: Date.now(),
    instance: 'edits',
    config,
    indexLagMs: 0,
    notify: () => {},
  });
  const command = (value) => shopify.command(context(), value);
  await command({
    kind: 'seed-catalog',
    products: [
      {
        id: '1',
        title: 'Canvas tote',
        vendor: 'Luma Goods',
        productType: 'Bags',
        published: true,
        variants: [
          {
            id: '11',
            sku: 'TOTE-NAT',
            title: 'Natural',
            price: '20.00',
            barcode: null,
            stock: { 1: 50 },
          },
          {
            id: '12',
            sku: 'TOTE-BLK',
            title: 'Black',
            price: '30.00',
            barcode: null,
            stock: { 1: 50 },
          },
        ],
      },
    ],
  });
  /** Places a paid order with three natural and one black tote. */
  const order = async () => {
    const created = await command({
      kind: 'order',
      lines: [
        { variant: '11', quantity: 3, price: '20.00' },
        { variant: '12', quantity: 1, price: '30.00' },
      ],
      location: '1',
      shipping: 'standard',
      financialStatus: 'PAID',
    });

    return {
      id: created.id,
      gid: created.gid,
      lines: created.lines.map((line) => `gid://shopify/LineItem/${line.id}`),
    };
  };
  const mutations = [];
  let lose = false;
  const transport = createTransport(async (request) => {
    const body = JSON.parse(request.body);
    if (body.query.startsWith('mutation')) mutations.push(body);
    const response = await shopify.handle(context(), request);
    if (body.query.includes('orderEditCommit') && lose) {
      lose = false;

      return { ...response, lost: true };
    }

    return response;
  });
  globalThis.fetch = async (url, init) =>
    String(url).startsWith(`https://${config.shop}/`)
      ? transport(url, init)
      : originalFetch(url, init);
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const f = await settingsFixture(t, origin, {
    connections: {
      activeKeyId: 'test',
      keys: new Map([['test', randomBytes(32)]]),
    },
  });
  // These journeys exercise writes; new workspaces otherwise stay observe-only.
  await f.request(
    f.owner,
    `${f.base}/settings/write-mode`,
    'PATCH',
    f.command({ revision: 0, writeMode: 'writes_enabled' }),
  );
  await f.db.owner.query(
    `GRANT luma_connectors TO "${new URL(f.db.runtimeUrl).username}"`,
  );
  const admin = await f.signup('EditApprover');
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
      label: 'Shopify edits',
      target: { kind: 'shopify', shop: config.shop },
      permissions: ['orders.read', 'fulfillment.read', 'orders.quantity.edit'],
      credentials: { token: 'synthetic' },
    },
    201,
  );
  await f.request(
    f.owner,
    `${f.base}/connections/${installed.id}/check`,
    'POST',
    { version: installed.version },
  );
  const call = (user, name, body, status = 200) =>
    f.request(
      user,
      `${f.base}/apps/shopify/order-edit-${name}`,
      'POST',
      body,
      status,
    );

  return {
    f,
    admin,
    installed,
    order,
    command,
    read: (id) => readOrder(context(), id),
    store,
    mutations,
    commits: () =>
      mutations.filter((body) => body.query.includes('orderEditCommit')).length,
    call,
    loseCommitResponse: () => {
      lose = true;
    },
  };
}
