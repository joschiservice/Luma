import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { bundlesFixture } from './shopify-bundles-fixture.mjs';

const gid = (kind, id) => `gid://shopify/${kind}/${id}`;

test('bundle recipes and sold groups keep component-only stock, split shipping and partial returns without adopting today’s recipe', async (t) => {
  const {
    f,
    installed,
    order,
    group,
    productUrl,
    orderUrl,
    runShopify,
    syncRecords,
    store,
    mutations,
  } = await bundlesFixture(t);
  let product = await f.request(f.owner, productUrl),
    detail = await f.request(f.owner, orderUrl);
  assert.equal(product.item.listings[0].requiresComponents, true);
  assert.equal(product.bundles[0].components[0].skuLabel, 'LUMA-001');
  assert.equal(product.bundles[0].variant.externalId, gid('ProductVariant', 2));
  assert.deepEqual(
    product.bundles[0].components.map((c) => [
      c.sourceId.externalId,
      c.sourceSku.externalId,
      c.quantity,
    ]),
    [
      [gid('ProductVariantComponent', 201), gid('InventoryItem', 1), '2'],
      [gid('ProductVariantComponent', 202), gid('InventoryItem', 3), '1'],
    ],
  );
  assert.equal(detail.sources.length, 1);
  assert.equal(detail.sources[0].lines.length, 2);
  assert.deepEqual(
    detail.sources[0].lines.map((l) => l.quantity),
    ['4', '2'],
  );
  for (const line of detail.sources[0].lines)
    assert.equal(
      line.bundleGroup.id.externalId,
      gid('LineItemGroup', group.id),
    );
  assert.equal((await store.get('InventoryLevel', '2.1')).data.committed, 0);
  assert.equal((await store.get('InventoryLevel', '1.1')).data.committed, 4);
  assert.equal((await store.get('InventoryLevel', '3.1')).data.committed, 2);
  await runShopify({
    kind: 'fulfill',
    order: order.id,
    lines: [{ lineItem: order.lines[0].id, quantity: 1 }],
    carrier: 'Carrier',
    trackingNumber: 'FIRST',
    trackingUrl: 'https://example.test/FIRST',
  });
  await runShopify({
    kind: 'fulfill',
    order: order.id,
    lines: [{ lineItem: order.lines[1].id, quantity: 2 }],
    carrier: 'Carrier',
    trackingNumber: 'SECOND',
    trackingUrl: 'https://example.test/SECOND',
  });
  await syncRecords('fulfillment.read', { limit: 100 });
  detail = await f.request(f.owner, orderUrl);
  assert.deepEqual(
    detail.sources[0].lines.map((l) => l.fulfilledQuantity),
    ['1', '2'],
  );
  assert.deepEqual(
    detail.sources[0].lines.map((l) => l.remainingQuantity),
    ['3', '0'],
  );
  assert.equal(
    detail.fulfillments.filter((v) => v.kind === 'shipment').length,
    2,
  );
  await runShopify({
    kind: 'return',
    order: order.id,
    lines: [{ lineItem: order.lines[0].id, quantity: 1 }],
    reason: 'Component damaged',
  });
  await runShopify({ kind: 'return-approve', order: order.id });
  await runShopify({ kind: 'return-receive', order: order.id });
  await runShopify({ kind: 'refund', order: order.id, outcome: 'success' });
  await syncRecords('returns.read', { limit: 100 });
  await syncRecords('orders.read', { limit: 100 });
  detail = await f.request(f.owner, orderUrl);
  assert.deepEqual(
    detail.sources[0].lines.map((l) => l.currentQuantity),
    ['3', '2'],
  );
  assert.equal(detail.sources[0].lines[0].bundleGroup.quantity, '2');
  assert.equal(detail.returns.length, 1);
  // A current substitution does not rewrite the earlier sale or its fulfillment/return identities.
  await runShopify({
    kind: 'bundle-recipe',
    variant: '2',
    requiresComponents: true,
    components: [{ id: '203', variant: '4', quantity: 3 }],
  });
  await syncRecords('products.read', { limit: 100 });
  product = await f.request(f.owner, productUrl);
  assert.equal(
    product.bundles[0].components[0].sourceSku.externalId,
    gid('InventoryItem', 4),
  );
  assert.ok(
    product.history.entries.some((entry) =>
      entry.bundle?.components?.some(
        (c) => c.sourceSku?.externalId === gid('InventoryItem', 3),
      ),
    ),
  );
  // A deleted component retains the historical group and SKU text, but text cannot repair its mapping.
  await store.delete('ProductVariant', '3');
  await syncRecords('orders.read', { limit: 100 });
  detail = await f.request(f.owner, orderUrl);
  const deleted = detail.sources[0].lines.find(
    (l) => l.skuCode === 'LUMA-BOTTLE',
  );
  assert.equal(deleted.skuId, null);
  assert.equal(
    deleted.bundleGroup.id.externalId,
    gid('LineItemGroup', group.id),
  );
  assert.equal(detail.sources[0].lines.length, 2);
  assert.equal((await store.get('InventoryLevel', '2.1')).data.committed, 0);
  assert.equal(mutations.length, 0);
  // Tenant isolation applies to the new recipe/detail evidence as to the owning records.
  const other = await f.request(
    f.owner,
    '/v1/organizations',
    'POST',
    {
      name: 'Other bundle shop',
      slug: `other-bundles-${randomUUID().slice(0, 8)}`,
    },
    201,
  );
  await f.request(
    f.owner,
    productUrl.replace(f.org.id, other.id),
    'GET',
    undefined,
    404,
  );
  await f.request(
    f.owner,
    orderUrl.replace(f.org.id, other.id),
    'GET',
    undefined,
    404,
  );
  assert.ok(installed.id);
});

test('a parent removed during recipe pagination keeps visibility unknown and detail access remains role scoped', async (t) => {
  let disappear = false;
  const { f, productUrl, parentSkuId, installed, syncRecords, orderUrl } =
    await bundlesFixture(t, undefined, {
      beforeShopifyRequest: async (body, store) => {
        if (disappear && body.query.includes('LumaBundleRecipes')) {
          await store.delete('ProductVariant', '2');
          disappear = false;
        }
      },
    });
  disappear = true;
  await syncRecords('products.read', { limit: 100 });
  const product = await f.request(f.owner, productUrl);
  assert.equal(product.bundles[0].requiresComponents, true);
  assert.equal(product.bundles[0].components, null);
  assert.ok(
    product.history.entries.some(
      (entry) => entry.bundle?.components?.length === 2,
    ),
  );
  // Catalog context has its own timestamp and does not claim a new physical balance.
  await syncRecords('inventory.read', {
    limit: 100,
    sku: { externalId: 'gid://shopify/InventoryItem/2', scopeKey: '' },
    location: { externalId: 'gid://shopify/Location/1', scopeKey: '' },
  });
  const inventory = await f.request(
    f.owner,
    `${f.base}/inventory?skuId=${parentSkuId}`,
  );
  const source = inventory.items[0].sources.find(
    (s) => s.connectionId === installed.id,
  );
  assert.equal(source.onHand, '100');
  assert.equal(source.bundleContext.componentCount, null);
  assert.equal(source.bundleContext.observedAt, product.bundles[0].observedAt);
  const role = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: 'http://localhost:3000',
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Stock reader',
      description: 'Only stock context',
      permissions: ['inventory.read'],
    },
  });
  assert.equal(role.statusCode, 201, role.body);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: role.json().id,
  });
  await f.request(f.member, productUrl, 'GET', undefined, 403);
  await f.request(f.member, orderUrl, 'GET', undefined, 403);
  await f.request(f.member, `${f.base}/inventory?skuId=${parentSkuId}`);
});
