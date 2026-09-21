import { expect, it } from 'vitest';

import { command, handle, seed } from './index.js';

it('maintains independent Shopify resources and cursor pages', () => {
  const state = seed(0);
  const other = seed(0);
  command(state, { kind: 'order', id: '1', quantity: 3 }, 1000);
  command(state, { kind: 'order', id: '2', quantity: 2 }, 1000);
  command(state, { kind: 'ship', id: '1' }, 2000);
  const request = {
    url: 'https://test.myshopify.com/admin/api/2026-07/graphql.json',
    method: 'POST',
    headers: { 'x-shopify-access-token': 'synthetic' },
    body: JSON.stringify({
      query: 'query LumaPage { page: orders(first: $first) { nodes { id } } }',
      variables: { first: 1, after: '1' },
    }),
  };
  expect(handle(state, request).body).toMatchObject({
    data: {
      page: {
        nodes: [{ id: 'gid://shopify/Order/2' }],
        pageInfo: { hasNextPage: false },
      },
    },
  });
  expect(state.nodes['gid://shopify/InventoryLevel/1']!.quantities).toEqual([
    { name: 'on_hand', quantity: 97 },
    { name: 'committed', quantity: 2 },
    { name: 'available', quantity: 95 },
  ]);
  expect(other.roots.orders).toEqual([]);
});
