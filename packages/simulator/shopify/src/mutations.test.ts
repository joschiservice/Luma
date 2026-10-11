import { createMemoryStore, type MemorySnapshot } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { shopify } from './index.js';
import {
  readOrder,
  readStock,
  readSubscriptions,
  subscriptionTopic,
} from './read.js';
import { catalog, createShop, graphqlRequest } from './test-support/shop.js';

const correction = `mutation LumaInventoryCorrection($input: InventorySetQuantitiesInput!, $key: String!) {
  result: inventorySetQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta quantityAfterChange } }
    userErrors { field message code }
  }
}`;

const quantityInput = (
  quantity: number,
  changeFromQuantity: number | null = 100,
) => ({
  name: 'available',
  reason: 'correction',
  referenceDocumentUri: 'luma://inventory-corrections/one',
  quantities: [
    {
      inventoryItemId: 'gid://shopify/InventoryItem/11',
      locationId: 'gid://shopify/Location/1',
      changeFromQuantity,
      quantity,
    },
  ],
});

const recovery = (
  mutation: string,
  extra = '',
  args = '',
  result = 'fulfillmentOrder',
) =>
  `mutation LumaFulfillmentRecovery($id: ID!${extra}) { result: ${mutation}(id: $id${args}) { resultOrder: ${result} { id status order { id } } userErrors { field message } } }`;

describe('inventorySetQuantities', () => {
  it('sets available stock with an exact compare-and-set and persistent receipts', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    shop.events.length = 0;
    const send = (key: string, input: unknown) =>
      shopify.handle(
        shop.context(),
        graphqlRequest(correction, { key, input }),
      );

    const accepted = await send('one', quantityInput(90));
    expect(accepted.committed).toBe(true);
    expect(accepted.body).toMatchObject({
      data: {
        result: {
          inventoryAdjustmentGroup: {
            reason: 'correction',
            referenceDocumentUri: 'luma://inventory-corrections/one',
            changes: [
              { name: 'available', delta: -10, quantityAfterChange: 90 },
            ],
          },
          userErrors: [],
        },
      },
    });
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 90,
      committed: 0,
      available: 90,
    });
    expect(shop.events.map((event) => event.topic)).toEqual([
      'inventory_levels/update',
    ]);

    // Receipts survive a store snapshot, as they do in the host database.
    const restored = createMemoryStore(
      JSON.parse(JSON.stringify(shop.store.snapshot())) as MemorySnapshot,
    );
    const replay = await shopify.handle(
      { ...shop.context(), store: restored },
      graphqlRequest(correction, { key: 'one', input: quantityInput(90) }),
    );
    expect(replay.body).toEqual(accepted.body);
    expect(replay.committed).toBeUndefined();

    const stale = await send('two', quantityInput(80));
    expect(stale.committed).toBeUndefined();
    expect(stale.body).toMatchObject({
      data: {
        result: {
          inventoryAdjustmentGroup: null,
          userErrors: [
            {
              code: 'CHANGE_FROM_QUANTITY_STALE',
              field: ['input', 'quantities', '0', 'changeFromQuantity'],
            },
          ],
        },
      },
    });
    expect(await send('one', quantityInput(80, 90))).toMatchObject({
      body: {
        data: {
          result: {
            userErrors: [{ code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH' }],
          },
        },
      },
    });
    expect(
      await send('three', { ...quantityInput(-1, 90), reason: 'whatever' }),
    ).toMatchObject({
      body: {
        data: {
          result: {
            userErrors: [
              { code: 'INVALID_REASON' },
              { code: 'INVALID_QUANTITY_NEGATIVE' },
            ],
          },
        },
      },
    });
    const unchecked = await send('four', quantityInput(70, null));
    expect(unchecked.committed).toBe(true);
    expect((await readStock(shop.context(), '11', '1'))?.available).toBe(70);

    const missingKey = await shop.query(
      'mutation ($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { code } } }',
      { input: quantityInput(60, 70) },
    );
    expect(missingKey.errors?.[0]?.message).toMatch(/@idempotent/);
    const unstocked = await send('five', {
      ...quantityInput(1, 0),
      quantities: [
        {
          ...quantityInput(1, 0).quantities[0],
          inventoryItemId: 'gid://shopify/InventoryItem/12',
          locationId: 'gid://shopify/Location/2',
        },
      ],
    });
    expect(unstocked.body).toMatchObject({
      data: {
        result: { userErrors: [{ code: 'ITEM_NOT_STOCKED_AT_LOCATION' }] },
      },
    });
  });

  it('keeps committed units when setting available stock', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    await shop.order();
    const response = await shopify.handle(
      shop.context(),
      graphqlRequest(correction, { key: 'k', input: quantityInput(50, 98) }),
    );

    expect(response.committed).toBe(true);
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 52,
      committed: 2,
      available: 50,
    });
  });
});

describe('fulfillment recovery', () => {
  async function held() {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order({ holds: ['INCORRECT_ADDRESS', 'OTHER'] });
    const work = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 1,
      })
    ).items[0]!;

    return { shop, order, id: `gid://shopify/FulfillmentOrder/${work.id}` };
  }

  it('releases a named hold and reports refused releases as user errors', async () => {
    const { shop, order, id } = await held();
    const read = await shop.query(
      'query LumaFulfillmentRecovery($id: ID!) { node(id: $id) { ... on FulfillmentOrder { status requestStatus supportedActions { action } fulfillmentHolds { id reason heldByRequestingApp } lineItems(first: 250) { nodes { remainingQuantity totalQuantity } pageInfo { hasNextPage } } } } }',
      { id },
    );
    const work = read.data?.node as {
      status: string;
      fulfillmentHolds: { id: string }[];
    };
    expect(read.data?.node).toMatchObject({
      status: 'ON_HOLD',
      requestStatus: 'UNSUBMITTED',
      supportedActions: [{ action: 'RELEASE_HOLD' }, { action: 'HOLD' }],
      fulfillmentHolds: [
        { reason: 'INCORRECT_ADDRESS', heldByRequestingApp: false },
        { reason: 'OTHER', heldByRequestingApp: false },
      ],
    });
    const release = (holdIds: string[]) =>
      shopify.handle(
        shop.context(),
        graphqlRequest(
          recovery(
            'fulfillmentOrderReleaseHold',
            ', $holdIds: [ID!]',
            ', holdIds: $holdIds',
          ),
          { id, holdIds },
        ),
      );

    shop.events.length = 0;
    const first = await release([work.fulfillmentHolds[0]!.id]);
    expect(first.committed).toBe(true);
    expect(first.body).toMatchObject({
      data: {
        result: {
          resultOrder: { id, status: 'ON_HOLD', order: { id: order.gid } },
          userErrors: [],
        },
      },
    });
    expect(shop.events.map((event) => event.topic)).toEqual([
      'fulfillment_holds/released',
      'orders/updated',
    ]);
    const unknown = await release(['gid://shopify/FulfillmentHold/1']);
    expect(unknown.committed).toBeUndefined();
    expect(unknown.body).toMatchObject({
      data: {
        result: {
          resultOrder: null,
          userErrors: [
            { field: ['id'], message: 'Fulfillment hold not found' },
          ],
        },
      },
    });
    await release([work.fulfillmentHolds[1]!.id]);
    expect((await readOrder(shop.context(), order.id))?.holds).toEqual([]);
    expect((await release([work.fulfillmentHolds[1]!.id])).body).toMatchObject({
      data: {
        result: {
          userErrors: [{ message: 'The fulfillment order is not on hold' }],
        },
      },
    });
  });

  it('opens scheduled work', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order({ fulfillAt: shop.now + 86_400_000 });
    const work = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 1,
      })
    ).items[0]!;
    const id = `gid://shopify/FulfillmentOrder/${work.id}`;
    expect(work.data).toMatchObject({ status: 'SCHEDULED' });
    const open = () =>
      shopify.handle(
        shop.context(),
        graphqlRequest(recovery('fulfillmentOrderOpen'), { id }),
      );

    expect((await open()).body).toMatchObject({
      data: { result: { resultOrder: { id, status: 'OPEN' }, userErrors: [] } },
    });
    expect((await open()).body).toMatchObject({
      data: { result: { resultOrder: null, userErrors: [{ field: ['id'] }] } },
    });
  });

  it('moves work and its committed stock to a location that can fulfill it', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order({
      lines: [
        { variant: '11', quantity: 3, price: '24.00' },
        { variant: '21', quantity: 1, price: '59.90' },
      ],
    });
    const work = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 1,
      })
    ).items[0]!;
    const id = `gid://shopify/FulfillmentOrder/${work.id}`;
    const options = await shop.query(
      'query LumaFulfillmentLocations($id: ID!) { node(id: $id) { ... on FulfillmentOrder { supportedActions { action } locationsForMove(first: 250) { nodes { location { id name } movable unavailableLineItemsCount { count precision } } pageInfo { hasNextPage } } } } }',
      { id },
    );
    expect(options.data?.node).toEqual({
      supportedActions: [
        'CREATE_FULFILLMENT',
        'REPORT_PROGRESS',
        'MOVE',
        'HOLD',
        'SPLIT',
      ].map((action) => ({ action })),
      locationsForMove: {
        nodes: [
          {
            location: { id: 'gid://shopify/Location/2', name: 'Vienna Depot' },
            movable: true,
            unavailableLineItemsCount: { count: 0, precision: 'EXACT' },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const move = (location: string) =>
      shopify.handle(
        shop.context(),
        graphqlRequest(
          recovery(
            'fulfillmentOrderMove',
            ', $newLocationId: ID!',
            ', newLocationId: $newLocationId',
            'movedFulfillmentOrder',
          ),
          { id, newLocationId: location },
        ),
      );

    expect((await move('gid://shopify/Location/1')).body).toMatchObject({
      data: {
        result: {
          resultOrder: null,
          userErrors: [
            {
              message:
                'The fulfillment order is already assigned to this location',
            },
          ],
        },
      },
    });
    const moved = await move('gid://shopify/Location/2');
    expect(moved.committed).toBe(true);
    expect(moved.body).toMatchObject({
      data: { result: { resultOrder: { id, status: 'OPEN' }, userErrors: [] } },
    });
    expect(await readStock(shop.context(), '11', '1')).toMatchObject({
      committed: 0,
    });
    expect(await readStock(shop.context(), '11', '2')).toMatchObject({
      committed: 3,
      available: 2,
    });
    expect((await readOrder(shop.context(), order.id))?.location).toBe('2');

    // Stock at the original location no longer covers the remaining work once it is sold.
    await shop.run({
      kind: 'available',
      variant: '21',
      location: '1',
      quantity: 0,
    });
    expect((await move('gid://shopify/Location/1')).body).toMatchObject({
      data: {
        result: {
          userErrors: [
            {
              message: 'The location cannot fulfill every remaining line item',
            },
          ],
        },
      },
    });
  });

  it('splits partly fulfilled work when it moves', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order({
      lines: [{ variant: '21', quantity: 3, price: '59.90' }],
    });
    const [line] = order.lines ?? [];
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      lines: [{ lineItem: line!.id, quantity: 1 }],
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://track.example/1',
    });
    const work = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 1,
      })
    ).items[0]!;
    const response = await shopify.handle(
      shop.context(),
      graphqlRequest(
        recovery(
          'fulfillmentOrderMove',
          ', $newLocationId: ID!',
          ', newLocationId: $newLocationId',
          'movedFulfillmentOrder',
        ),
        {
          id: `gid://shopify/FulfillmentOrder/${work.id}`,
          newLocationId: 'gid://shopify/Location/2',
        },
      ),
    );
    const moved = (
      response.body as { data: { result: { resultOrder: { id: string } } } }
    ).data.result.resultOrder;

    expect(moved.id).not.toBe(`gid://shopify/FulfillmentOrder/${work.id}`);
    expect(
      (await shop.store.get('FulfillmentOrder', work.id))?.data,
    ).toMatchObject({ status: 'CLOSED' });
    expect(await readStock(shop.context(), '21', '2')).toMatchObject({
      committed: 2,
    });
    expect(
      (await readOrder(shop.context(), order.id))?.lines[0]?.unfulfilled,
    ).toBe(2);
  });
});

describe('webhook subscriptions', () => {
  it('records subscriptions and refuses duplicates', async () => {
    const shop = createShop();
    const create = (uri: string) =>
      shopify.handle(
        shop.context(),
        graphqlRequest(
          'mutation LumaLifecycleWebhook($uri: String!) { webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }',
          { uri },
        ),
      );
    const created = await create(
      'https://luma.example/api/v1/shopify/changes/t/c',
    );

    expect(created.committed).toBe(true);
    expect(created.body).toMatchObject({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: expect.stringMatching(
              /^gid:\/\/shopify\/WebhookSubscription\//,
            ),
          },
          userErrors: [],
        },
      },
    });
    expect(
      (await create('https://luma.example/api/v1/shopify/changes/t/c')).body,
    ).toMatchObject({
      data: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [
            { message: 'Address for this topic has already been taken' },
          ],
        },
      },
    });
    expect(
      (
        await shop.query(
          'query LumaLifecycleSubscriptions { webhookSubscriptions(first: 100, topics: [ORDERS_CREATE]) { nodes { uri } } }',
        )
      ).data,
    ).toEqual({
      webhookSubscriptions: {
        nodes: [{ uri: 'https://luma.example/api/v1/shopify/changes/t/c' }],
      },
    });
    expect(
      (
        await shop.query(
          'query { webhookSubscriptions(first: 100, topics: [APP_UNINSTALLED]) { nodes { uri } } }',
        )
      ).data,
    ).toEqual({ webhookSubscriptions: { nodes: [] } });
    expect(await readSubscriptions(shop.context())).toEqual([
      {
        id: expect.any(String),
        topic: 'ORDERS_CREATE',
        uri: 'https://luma.example/api/v1/shopify/changes/t/c',
      },
    ]);
    expect(subscriptionTopic('fulfillment_orders/placed_on_hold')).toBe(
      'FULFILLMENT_ORDERS_PLACED_ON_HOLD',
    );
  });
});

it('creates marked returns and approves the exact customer request through the Admin API', async () => {
  const shop = createShop({
    scopes: ['read_orders', 'read_all_orders', 'read_returns', 'write_returns'],
  });
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const order = await shop.order();
  await shop.run({
    kind: 'fulfill',
    order: order.id,
    carrier: 'DHL',
    trackingNumber: 'one',
    trackingUrl: 'https://example.test/one',
  });
  const shipments = (
    await shop.store.page({ kind: 'Fulfillment', parent: order.id, limit: 10 })
  ).items;
  const lines = (
    await shop.store.page({
      kind: 'FulfillmentLineItem',
      parent: shipments[0]!.id,
      limit: 10,
    })
  ).items;
  const send = (query: string, variables: Record<string, unknown>) =>
    shopify.handle(shop.context(), graphqlRequest(query, variables));
  const created = await send(
    `mutation($input: ReturnInput!) { returnCreate(returnInput: $input) { return { id status returnLineItems(first: 10) { nodes { returnReasonNote } } } userErrors { message } } }`,
    {
      input: {
        orderId: `gid://shopify/Order/${order.id}`,
        returnLineItems: [
          {
            fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${lines[0]!.id}`,
            quantity: 1,
            returnReason: 'OTHER',
            returnReasonNote: 'luma-rc:00000000-0000-4000-8000-000000000001',
          },
        ],
      },
    },
  );
  expect(created.body).not.toHaveProperty('errors');
  expect(created.committed).toBe(true);
  expect(created.body).toMatchObject({
    data: {
      returnCreate: {
        return: {
          status: 'OPEN',
          returnLineItems: {
            nodes: [
              {
                returnReasonNote:
                  'luma-rc:00000000-0000-4000-8000-000000000001',
              },
            ],
          },
        },
        userErrors: [],
      },
    },
  });
  const source = await readOrder(shop.context(), order.id);
  const requested = await shop.run({
    kind: 'return',
    order: order.id,
    lines: [{ lineItem: source!.lines[0]!.id, quantity: 1 }],
    reason: 'Wrong size',
  });
  const approved = await send(
    `mutation($input: ReturnApproveRequestInput!) { returnApproveRequest(input: $input) { return { id status returnLineItems(first:10) { nodes { returnReasonNote } } } userErrors { message } } }`,
    { input: { id: requested.gid, notifyCustomer: false } },
  );
  expect(approved.body).toMatchObject({
    data: {
      returnApproveRequest: {
        return: {
          id: requested.gid,
          status: 'OPEN',
          returnLineItems: { nodes: [{ returnReasonNote: '' }] },
        },
        userErrors: [],
      },
    },
  });
});
