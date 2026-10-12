import { expect, it } from 'vitest';

import { catalog, createShop } from './test-support/shop.js';

it('keeps sold groups stable when recipes change and commits only actual components', async () => {
  const shop = createShop();
  await shop.run({ kind: 'seed-catalog', products: catalog });
  await shop.run({
    kind: 'bundle-recipe',
    variant: '11',
    requiresComponents: true,
    components: [{ id: '201', variant: '12', quantity: 2 }],
  });
  const group = {
    id: '220',
    title: 'Sold tote pack',
    quantity: 2,
    product: '10',
    variant: '11',
    sku: 'TOTE-NAT',
  };
  const order = await shop.run({
    kind: 'order',
    lines: [{ variant: '12', quantity: 4, price: '20.00', bundleGroup: group }],
    location: '1',
    shipping: 'standard',
    financialStatus: 'PAID',
  });
  expect((await shop.store.get('InventoryLevel', '11.1'))?.data).toMatchObject({
    onHand: 100,
    committed: 0,
  });
  expect((await shop.store.get('InventoryLevel', '12.1'))?.data).toMatchObject({
    onHand: 40,
    committed: 4,
  });
  await shop.run({
    kind: 'bundle-recipe',
    variant: '11',
    requiresComponents: false,
    components: [],
  });
  const response = await shop.query(
    `query { node(id:"${order.gid}") { ... on Order { lineItems(first:8) { nodes { quantity lineItemGroup { id title quantity variantId } } } } } }`,
  );
  expect(response).toMatchObject({
    data: {
      node: {
        lineItems: {
          nodes: [
            {
              quantity: 4,
              lineItemGroup: {
                id: 'gid://shopify/LineItemGroup/220',
                title: 'Sold tote pack',
                quantity: 2,
                variantId: 'gid://shopify/ProductVariant/11',
              },
            },
          ],
        },
      },
    },
  });
  await shop.store.delete('ProductVariant', '12');
  expect(
    await shop.query(
      `query { node(id:"${order.gid}") { ... on Order { lineItems(first:8) { nodes { variant { id } lineItemGroup { id } } } } } }`,
    ),
  ).toMatchObject({
    data: {
      node: {
        lineItems: {
          nodes: [
            {
              variant: null,
              lineItemGroup: { id: 'gid://shopify/LineItemGroup/220' },
            },
          ],
        },
      },
    },
  });
});

it('enforces native catalog and sold-group scopes for exact bundle reads', async () => {
  const shop = createShop({ scopes: ['read_inventory'] });
  expect(
    await shop.query(
      'query { node(id:"gid://shopify/ProductVariant/11") { id } }',
    ),
  ).toMatchObject({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] });
  expect(
    await shop.query(
      'query { node(id:"gid://shopify/LineItemGroup/220") { id } }',
    ),
  ).toMatchObject({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] });
});
