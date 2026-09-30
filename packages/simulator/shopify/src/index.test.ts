import { expect, it } from 'vitest';

import { command, handle, seed, stock } from './index.js';

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
  expect(state.children['gid://shopify/Order/1']!.fulfillmentOrders).toEqual([
    'gid://shopify/FulfillmentOrder/1',
  ]);
  expect(state.nodes['gid://shopify/FulfillmentOrder/1']).toMatchObject({
    status: 'CLOSED',
    updatedAt: new Date(2000).toISOString(),
  });
  expect(state.nodes['gid://shopify/FulfillmentOrderLineItem/1']).toMatchObject(
    { remainingQuantity: 0, totalQuantity: 3 },
  );
  expect(other.roots.orders).toEqual([]);
});

it('holds and releases fulfillment work without changing stock', () => {
  const state = seed(0);
  command(state, { kind: 'order', id: '5', quantity: 1 }, 1000);
  const before = structuredClone(state.nodes['gid://shopify/InventoryLevel/1']);
  command(state, { kind: 'hold', id: '5', reason: 'INCORRECT_ADDRESS' }, 2000);
  expect(state.nodes['gid://shopify/FulfillmentOrder/5']).toMatchObject({
    status: 'ON_HOLD',
    updatedAt: new Date(2000).toISOString(),
    fulfillmentHolds: [{ reason: 'INCORRECT_ADDRESS' }],
    assignedLocation: { location: { id: 'gid://shopify/Location/1' } },
  });
  expect(() => command(state, { kind: 'ship', id: '5' }, 2500)).toThrow(
    'Release the fulfillment hold before shipping',
  );
  command(state, { kind: 'release', id: '5' }, 3000);
  expect(state.nodes['gid://shopify/FulfillmentOrder/5']).toMatchObject({
    status: 'OPEN',
    fulfillmentHolds: [],
  });
  expect(state.nodes['gid://shopify/InventoryLevel/1']).toEqual(before);
  command(state, { kind: 'ship', id: '5' }, 4000);
  expect(state.nodes['gid://shopify/Fulfillment/5']).toMatchObject({
    displayStatus: 'IN_TRANSIT',
    trackingInfo: [{ company: 'DHL', number: '003404340000000005' }],
  });
});

it('persists inventory CAS receipts and refuses concurrent changes without overwriting them', () => {
  const state = seed(Date.now());
  const input = {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'luma://test',
    quantities: [
      {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        changeFromQuantity: 100,
        quantity: 90,
      },
    ],
  };
  const request = (key: string, quantity = 90) => ({
    url: 'https://test.myshopify.com/admin/api/2026-07/graphql.json',
    method: 'POST',
    headers: { 'x-shopify-access-token': 'synthetic' },
    body: JSON.stringify({
      query: 'mutation LumaInventoryCorrection { inventorySetQuantities }',
      variables: {
        key,
        input: { ...input, quantities: [{ ...input.quantities[0], quantity }] },
      },
    }),
  });
  const first = handle(state, request('one'));
  expect(first.body).toMatchObject({ data: { result: { userErrors: [] } } });
  const restored = JSON.parse(JSON.stringify(state));
  expect(handle(restored, request('one')).body).toEqual(first.body);
  expect(stock(restored).available).toBe(90);
  expect(handle(restored, request('two')).body).toMatchObject({
    data: { result: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE' }] } },
  });
  expect(handle(restored, request('one', 80)).body).toMatchObject({
    data: { result: { userErrors: [{ code: 'IDEMPOTENCY_KEY_CONFLICT' }] } },
  });
  expect(stock(restored).available).toBe(90);
});

it('follows a return from request through receipt, refund attempts and close', () => {
  const state = seed(0);
  command(state, { kind: 'order', id: '5', quantity: 2 }, 1000);
  expect(() =>
    command(state, { kind: 'return', id: '5', quantity: 1 }, 1500),
  ).toThrow('Ship the order first');
  command(state, { kind: 'ship', id: '5' }, 2000);
  command(state, { kind: 'return', id: '5', quantity: 1 }, 3000);
  command(state, { kind: 'return-approve', id: '5' }, 4000);
  command(state, { kind: 'return-receive', id: '5' }, 5000);
  command(state, { kind: 'refund', id: '5', outcome: 'failure' }, 6000);
  command(state, { kind: 'refund', id: '5', outcome: 'pending' }, 7000);
  command(state, { kind: 'refund-settle', id: '5' }, 8000);
  command(state, { kind: 'return-close', id: '5' }, 9000);
  const read = (query: string, variables: Record<string, unknown>) =>
    handle(state, {
      url: 'https://test.myshopify.com/admin/api/2026-07/graphql.json',
      method: 'POST',
      headers: { 'x-shopify-access-token': 'synthetic' },
      body: JSON.stringify({ query, variables }),
    }).body as { data: Record<string, unknown> };
  expect(
    read(
      'query LumaPage { page: orders(first: $first) { nodes { id returns(first: 1) { nodes { id } } refunds(first: 1) { id } } } }',
      { first: 10 },
    ).data,
  ).toMatchObject({
    page: {
      nodes: [
        {
          id: 'gid://shopify/Order/5',
          returns: { nodes: [{ id: 'gid://shopify/Return/5' }] },
          refunds: [
            { id: 'gid://shopify/Refund/501' },
            { id: 'gid://shopify/Refund/502' },
          ],
        },
      ],
    },
  });
  expect(state.nodes['gid://shopify/Return/5']).toMatchObject({
    status: 'CLOSED',
    closedAt: new Date(9000).toISOString(),
  });
  const transactions = [
    'gid://shopify/Refund/501',
    'gid://shopify/Refund/502',
  ].map(
    (id) =>
      read(
        'query LumaChildren { node(id: $id) { ... on Refund { children: transactions(first: 100) { nodes { id } } } } }',
        { id },
      ).data,
  );
  expect(transactions).toMatchObject([
    { node: { children: { nodes: [{ status: 'FAILURE' }] } } },
    { node: { children: { nodes: [{ status: 'SUCCESS' }] } } },
  ]);
  // Received units return to stock.
  expect(stock(state)).toMatchObject({ onHand: 99, available: 99 });
});
