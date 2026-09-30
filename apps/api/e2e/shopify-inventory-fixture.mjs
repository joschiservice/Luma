import { randomBytes } from 'node:crypto';

import { handle, seed } from '@luma/simulator-shopify';

import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

export const stockItem = 'gid://shopify/InventoryItem/1';

export const stockLocation = 'gid://shopify/Location/1';

/** Exercises real stock, approval and execution services against an isolated Shopify simulator. */
export async function correctionFixture(t, origin = 'http://localhost:3000') {
  const originalFetch = globalThis.fetch;
  const state = seed(Date.now());
  const level = state.nodes['gid://shopify/InventoryLevel/1'];
  level.quantities.find((q) => q.name === 'available').quantity = 12;
  level.quantities.find((q) => q.name === 'on_hand').quantity = 12;
  const mutations = [];
  let lost = false,
    race = false,
    delayVerification = false;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://stock.myshopify.com/'))
      return originalFetch(url, init);
    const body = JSON.parse(init.body);
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      if (race) {
        level.quantities.find((q) => q.name === 'available').quantity = 10;
        race = false;
      }
    }
    const response = handle(state, {
      url: String(url),
      method: 'POST',
      headers: { 'x-shopify-access-token': 'synthetic' },
      body: init.body,
    });
    if (body.query.startsWith('mutation') && lost) {
      lost = false;
      throw new Error('Lost response after commit');
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

    return Response.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
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
    { userId: admin.id, role: 'admin' },
    201,
  );
  await f.request(f.owner, `${f.base}/apps/shopify/install`, 'POST', {
    version: null,
  });
  await f.request(f.owner, `${f.base}/apps/jtl/install`, 'POST', {
    version: null,
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
    state,
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
