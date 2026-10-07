import { randomBytes } from 'node:crypto';

import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { readStock, shopify } from '@luma/simulator-shopify';

import { appScopes } from './app-scopes.mjs';
import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

export const stockItem = 'gid://shopify/InventoryItem/1';

export const stockLocation = 'gid://shopify/Location/1';

const config = {
  shop: 'stock.myshopify.com',
  name: 'Stock',
  currency: 'EUR',
  orderPrefix: 'S',
  locations: [{ id: '1', name: 'Simulator warehouse' }],
  scopes: [
    'read_orders',
    'read_products',
    'read_inventory',
    'read_merchant_managed_fulfillment_orders',
    'read_returns',
    'write_inventory',
  ],
};

/** Exercises real stock, approval and execution services against an isolated Shopify simulator. */
export async function correctionFixture(t, origin = 'http://localhost:3000') {
  const originalFetch = globalThis.fetch;
  const store = createMemoryStore();
  const context = () => ({
    store,
    now: Date.now(),
    wallTime: Date.now(),
    instance: 'stock',
    config,
    indexLagMs: 0,
    notify: () => {},
  });
  await shopify.command(context(), {
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
            id: '1',
            sku: 'LUMA-001',
            title: 'Default Title',
            price: '24.00',
            barcode: '4006381333931',
            stock: { 1: 12 },
          },
        ],
      },
    ],
  });
  // Mirrors the provider's current quantities after every simulated request.
  const level = { quantities: [] };
  const refresh = async () => {
    const current = await readStock(context(), '1', '1');
    level.quantities = [
      { name: 'on_hand', quantity: current.onHand },
      { name: 'committed', quantity: current.committed },
      { name: 'available', quantity: current.available },
    ];
  };
  await refresh();
  const mutations = [];
  let lost = false,
    race = false,
    delayVerification = false;
  const transport = createTransport(async (request) => {
    const body = JSON.parse(request.body);
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      if (race) {
        await shopify.command(context(), {
          kind: 'available',
          variant: '1',
          location: '1',
          quantity: 10,
        });
        race = false;
      }
    }
    const response = await shopify.handle(context(), request);
    await refresh();
    if (body.query.startsWith('mutation') && lost) {
      lost = false;

      return { ...response, lost: true };
    }
    if (
      body.query.startsWith('query LumaInventoryCorrection') &&
      delayVerification &&
      mutations.length &&
      response.body.data.node?.inventoryLevel
    ) {
      response.body.data.node.inventoryLevel.quantities = [
        { name: 'available', quantity: 12 },
      ];
    }

    return response;
  });
  globalThis.fetch = async (url, init) =>
    String(url).startsWith('https://stock.myshopify.com/')
      ? transport(url, init)
      : originalFetch(url, init);
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const connectionsConfig = {
    activeKeyId: 'test',
    keys: new Map([['test', randomBytes(32)]]),
  };
  const f = await settingsFixture(t, origin, {
    connections: connectionsConfig,
  });
  await f.db.owner.query(
    `GRANT luma_connectors TO "${new URL(f.db.runtimeUrl).username}"`,
  );
  const admin = await f.signup('StockApprover');
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
  await f.request(f.owner, `${f.base}/apps/jtl/install`, 'POST', {
    version: null,
    scopes: appScopes.jtl,
  });
  const installed = await f.request(
    f.owner,
    `${f.base}/connections`,
    'POST',
    {
      label: 'Shopify stock',
      target: { kind: 'shopify', shop: 'stock.myshopify.com' },
      permissions: ['inventory.read', 'inventory.available.reconcile'],
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
  const stock = await inventoryFixture(t, f);
  await f.db.owner.query(
    `UPDATE connector_installations SET document=document || $3::jsonb WHERE tenant_id=$1 AND id=$2`,
    [
      f.org.id,
      stock.erp,
      JSON.stringify({
        appId: 'jtl',
        appInstallationVersion: 1,
        permissions: ['inventory.read'],
        granted: ['inventory.read'],
      }),
    ],
  );
  await stock.stock({
    connectionId: stock.erp,
    external: '77',
    location: stockLocation,
    amount: '9',
  });
  await stock.stock({
    connectionId: installed.id,
    external: stockItem,
    location: stockLocation,
    amount: '12',
  });
  const list = await f.request(
    f.owner,
    `${f.base}/inventory?connectionId=${installed.id}`,
  );
  const position = list.items.find((p) =>
    p.sources.some((s) => s.connectionId === installed.id),
  );
  const target = {
    positionId: position.id,
    connectionId: installed.id,
    sourceConnectionId: stock.erp,
  };
  const call = (user, command, body, status = 200) =>
    f.request(
      user,
      `${f.base}/apps/shopify/inventory-correction-${command}`,
      'POST',
      body,
      status,
    );

  return {
    f,
    connectionsConfig,
    admin,
    installed,
    stock,
    store,
    level,
    mutations,
    target,
    call,
    loseResponse: () => {
      lost = true;
    },
    race: () => {
      race = true;
    },
    delayVerification: (value) => {
      delayVerification = value;
    },
  };
}
