import { describe, expect, it } from 'vitest';

import { shopify } from './index.js';
import { readStock } from './read.js';
import { simulatorAppId } from './records.js';
import { catalog, createShop, graphqlRequest } from './test-support/shop.js';

const moneyFragment =
  'fragment LumaMoney on MoneyBag { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }';

const readQuery = `query LumaOrderEditRead($id: ID!) { node(id: $id) { ... on Order { id updatedAt cancelledAt closed currencyCode presentmentCurrencyCode currentSubtotalPriceSet { ...LumaMoney } currentTotalPriceSet { ...LumaMoney } totalOutstandingSet { ...LumaMoney } lineItems(first: 100) { nodes { id name sku quantity currentQuantity unfulfilledQuantity } pageInfo { hasNextPage } } fulfillmentOrders(first: 5) { nodes { id status requestStatus lineItems(first: 50) { nodes { lineItem { id } remainingQuantity totalQuantity } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } } ${moneyFragment}`;

const proofQuery =
  'query LumaOrderEditProof($id: ID!, $query: String) { currentAppInstallation { app { id } } node(id: $id) { ... on Order { id updatedAt cancelledAt lineItems(first: 100) { nodes { id currentQuantity } pageInfo { hasNextPage } } agreements(first: 5, reverse: true, query: $query) { nodes { __typename id happenedAt reason app { id } sales(first: 25) { nodes { __typename actionType lineType quantity ... on ProductSale { lineItem { id } } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }';

const beginMutation =
  'mutation LumaOrderEditBegin($id: ID!) { result: orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }';

const lumaSetQuantityMutation = `mutation LumaOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) { result: orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) { calculatedOrder { id subtotalPriceSet { ...LumaMoney } totalPriceSet { ...LumaMoney } totalOutstandingSet { ...LumaMoney } lineItems(first: 100) { nodes { id quantity } pageInfo { hasNextPage } } } userErrors { field message } } } ${moneyFragment}`;

/** The Luma document with every calculated line field, for preview assertions. */
const setQuantityMutation = `mutation LumaOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) { result: orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) { calculatedOrder { id subtotalPriceSet { ...LumaMoney } totalPriceSet { ...LumaMoney } totalOutstandingSet { ...LumaMoney } lineItems(first: 100) { nodes { id quantity editableQuantity restocking } pageInfo { hasNextPage } } } userErrors { field message } } } ${moneyFragment}`;

const commitMutation =
  'mutation LumaOrderEditCommit($id: ID!, $staffNote: String) { result: orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id updatedAt } userErrors { field message } } }';

const eur = (amount: string) => ({
  shopMoney: { amount, currencyCode: 'EUR' },
  presentmentMoney: { amount, currencyCode: 'EUR' },
});

interface Body {
  data?: Record<string, Record<string, unknown> | null>;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number } };
}

/** A seeded shop with one order of two totes and a black tote, and Admin API helpers. */
async function setup(
  options: Parameters<typeof createShop>[0] = {},
  order: Parameters<ReturnType<typeof createShop>['order']>[0] = {},
) {
  const shop = createShop(options);
  await shop.run({ kind: 'seed-catalog', products: catalog });
  const placed = await shop.order(order);
  const [tote, black] = placed.lines ?? [];
  if (!tote || !black) throw new Error('The order has no lines');
  shop.advance(60_000);
  shop.events.length = 0;
  const send = async (query: string, variables: Record<string, unknown>) => {
    const response = await shopify.handle(
      shop.context(),
      graphqlRequest(query, variables),
    );

    return { committed: response.committed, body: response.body as Body };
  };
  const begin = async () => {
    const { body } = await send(beginMutation, { id: placed.gid });
    const calculated = body.data?.result?.calculatedOrder;
    const id: unknown =
      typeof calculated === 'object' && calculated !== null
        ? Reflect.get(calculated, 'id')
        : undefined;
    if (typeof id !== 'string') throw new Error('orderEditBegin failed');

    return id;
  };
  const stage = (id: string, line: string, quantity: number, restock = true) =>
    send(setQuantityMutation, {
      id,
      lineItemId: `gid://shopify/CalculatedLineItem/${line}`,
      quantity,
      restock,
    });
  const commit = (id: string) =>
    send(commitMutation, { id, staffNote: 'luma:edit-1' });

  return { shop, order: placed, tote, black, send, begin, stage, commit };
}

describe('order edit sessions', () => {
  it('previews and commits a reduction with released stock, totals, one webhook and an app agreement', async () => {
    const { shop, order, tote, black, send, begin, stage, commit } =
      await setup();
    const before = shop.store
      .snapshot()
      .records.find(
        (record) => record.kind === 'Order' && record.id === order.id,
      );

    const begun = await send(beginMutation, { id: order.gid });
    expect(begun.committed).toBeUndefined();
    expect(begun.body.extensions?.cost?.requestedQueryCost).toBe(10);
    const id = await begin();
    expect(id).toMatch(/^gid:\/\/shopify\/CalculatedOrder\/\d+$/);

    const luma = await send(lumaSetQuantityMutation, {
      id,
      lineItemId: `gid://shopify/CalculatedLineItem/${black.id}`,
      quantity: 1,
      restock: true,
    });
    expect(luma.body.extensions?.cost?.requestedQueryCost).toBe(10);
    expect(luma.body.data?.result).toMatchObject({
      calculatedOrder: {
        id,
        totalPriceSet: eur('74.5'),
        lineItems: {
          nodes: [
            { id: `gid://shopify/CalculatedLineItem/${tote.id}`, quantity: 2 },
            { id: `gid://shopify/CalculatedLineItem/${black.id}`, quantity: 1 },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
      userErrors: [],
    });
    const staged = await stage(id, tote.id, 1);
    expect(staged.committed).toBeUndefined();
    expect(staged.body).toMatchObject({
      data: {
        result: {
          calculatedOrder: {
            id,
            subtotalPriceSet: eur('50.5'),
            totalPriceSet: eur('50.5'),
            totalOutstandingSet: eur('0.0'),
            lineItems: {
              nodes: [
                {
                  id: `gid://shopify/CalculatedLineItem/${tote.id}`,
                  quantity: 1,
                  editableQuantity: 1,
                  restocking: true,
                },
                {
                  id: `gid://shopify/CalculatedLineItem/${black.id}`,
                  quantity: 1,
                  editableQuantity: 1,
                  restocking: false,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
          userErrors: [],
        },
      },
    });
    expect(
      shop.store
        .snapshot()
        .records.find(
          (record) => record.kind === 'Order' && record.id === order.id,
        ),
    ).toEqual(before);
    expect(shop.events).toHaveLength(0);

    const started = shop.now;
    const committed = await commit(id);
    expect(committed.committed).toBe(true);
    expect(committed.body.data?.result).toEqual({
      order: { id: order.gid, updatedAt: expect.any(String) },
      userErrors: [],
    });
    expect(
      shop.events.filter((event) => event.topic === 'orders/edited'),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          order_edit: expect.objectContaining({
            app_id: 1,
            staff_note: 'luma:edit-1',
            line_items: {
              additions: [],
              removals: [{ id: Number(tote.id), delta: 1 }],
            },
          }),
        }),
      }),
    ]);
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 100,
      committed: 1,
      available: 99,
    });

    const read = await send(readQuery, { id: order.gid });
    expect(read.body.errors).toBeUndefined();
    expect(read.body.extensions?.cost?.requestedQueryCost).toBeLessThanOrEqual(
      1000,
    );
    expect(read.body.data?.node).toMatchObject({
      currentSubtotalPriceSet: eur('50.5'),
      currentTotalPriceSet: eur('50.5'),
      totalOutstandingSet: eur('0.0'),
      lineItems: {
        nodes: [
          { quantity: 2, currentQuantity: 1, unfulfilledQuantity: 1 },
          { quantity: 1, currentQuantity: 1, unfulfilledQuantity: 1 },
        ],
      },
      fulfillmentOrders: {
        nodes: [
          {
            status: 'OPEN',
            lineItems: {
              nodes: [
                { remainingQuantity: 1, totalQuantity: 1 },
                { remainingQuantity: 1, totalQuantity: 1 },
              ],
            },
          },
        ],
      },
    });

    const proof = await send(proofQuery, {
      id: order.gid,
      query: `happened_at:>='${new Date(started - 1000).toISOString()}'`,
    });
    expect(proof.body.errors).toBeUndefined();
    expect(proof.body.extensions?.cost?.requestedQueryCost).toBeLessThanOrEqual(
      1000,
    );
    expect(proof.body.data).toEqual({
      currentAppInstallation: { app: { id: simulatorAppId } },
      node: expect.objectContaining({
        agreements: {
          nodes: [
            {
              __typename: 'OrderEditAgreement',
              id: expect.stringMatching(
                /^gid:\/\/shopify\/OrderEditAgreement\//,
              ),
              happenedAt: new Date(started).toISOString().replace('.000', ''),
              reason: 'ORDER_EDIT',
              app: { id: simulatorAppId },
              sales: {
                nodes: [
                  {
                    __typename: 'ProductSale',
                    actionType: 'RETURN',
                    lineType: 'PRODUCT',
                    quantity: -1,
                    lineItem: { id: `gid://shopify/LineItem/${tote.id}` },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    });
  });

  it('adds units to open work, commits stock and raises totals in both currencies', async () => {
    const { shop, order, black, send, begin, stage, commit } = await setup(
      {},
      { presentment: { currency: 'CHF', rate: 0.9 } },
    );
    const id = await begin();
    expect((await stage(id, black.id, 3)).body).toMatchObject({
      data: {
        result: {
          calculatedOrder: {
            totalPriceSet: {
              shopMoney: { amount: '127.5', currencyCode: 'EUR' },
              presentmentMoney: { amount: '114.75', currencyCode: 'CHF' },
            },
            totalOutstandingSet: {
              shopMoney: { amount: '53.0', currencyCode: 'EUR' },
              presentmentMoney: { amount: '47.7', currencyCode: 'CHF' },
            },
            lineItems: {
              nodes: [
                { quantity: 2, editableQuantity: 2, restocking: false },
                { quantity: 3, editableQuantity: 3, restocking: false },
              ],
            },
          },
          userErrors: [],
        },
      },
    });
    expect((await commit(id)).committed).toBe(true);
    expect(await readStock(shop.context(), '12', '1')).toEqual({
      onHand: 40,
      committed: 3,
      available: 37,
    });
    const read = await send(readQuery, { id: order.gid });
    expect(read.body.data?.node).toMatchObject({
      currentTotalPriceSet: { shopMoney: { amount: '127.5' } },
      lineItems: {
        nodes: [
          { currentQuantity: 2 },
          { quantity: 1, currentQuantity: 3, unfulfilledQuantity: 3 },
        ],
      },
      fulfillmentOrders: {
        nodes: [
          {
            lineItems: {
              nodes: [
                { remainingQuantity: 2, totalQuantity: 2 },
                { remainingQuantity: 3, totalQuantity: 3 },
              ],
            },
          },
        ],
      },
    });
    const proof = await send(proofQuery, { id: order.gid });
    expect(proof.body.data?.node).toMatchObject({
      agreements: {
        nodes: [
          {
            sales: {
              nodes: [{ actionType: 'ORDER', quantity: 2 }],
            },
          },
        ],
      },
    });
  });

  it('refuses edits Shopify does not allow without changing records', async () => {
    const { shop, order, tote, send, begin, stage } = await setup();
    const other = await shop.order();
    const id = await begin();
    const before = shop.store.snapshot();
    shop.events.length = 0;

    expect(
      (await send(beginMutation, { id: 'gid://shopify/Order/999' })).body.data,
    ).toEqual({
      result: {
        calculatedOrder: null,
        userErrors: [{ field: ['id'], message: 'Order does not exist.' }],
      },
    });
    expect(
      (await stage(id, other.lines![0]!.id, 1)).body.data?.result,
    ).toMatchObject({
      calculatedOrder: null,
      userErrors: [{ field: ['lineItemId'] }],
    });
    expect((await stage(id, tote.id, -1)).body.data?.result).toMatchObject({
      userErrors: [{ field: ['quantity'] }],
    });
    expect(
      (await stage('gid://shopify/CalculatedOrder/1', tote.id, 1)).body.data
        ?.result,
    ).toMatchObject({ userErrors: [{ field: ['id'] }] });
    expect((await send(commitMutation, { id })).body.data?.result).toEqual({
      order: null,
      userErrors: [
        { field: ['id'], message: 'The order edit has no changes to commit.' },
      ],
    });
    expect(shop.store.snapshot()).toEqual(before);
    expect(shop.events).toHaveLength(0);

    await shop.run({
      kind: 'fulfill',
      order: order.id,
      lines: [{ lineItem: tote.id, quantity: 1 }],
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://tracking.example/1',
    });
    expect((await stage(id, tote.id, 0)).body.data?.result).toMatchObject({
      userErrors: [
        { field: ['quantity'], message: 'Shipped units cannot be removed' },
      ],
    });

    await shop.run({ kind: 'cancel', order: other.id, reason: 'CUSTOMER' });
    expect(
      (await send(beginMutation, { id: other.gid })).body.data?.result,
    ).toMatchObject({
      calculatedOrder: null,
      userErrors: [{ field: ['id'], message: 'The order cannot be edited' }],
    });
  });

  it('requires the write_order_edits scope', async () => {
    const { send, order } = await setup({
      scopes: ['read_orders', 'read_all_orders', 'write_orders'],
    });
    const { body } = await send(beginMutation, { id: order.gid });

    expect(body.data).toEqual({ result: null });
    expect(body.errors).toMatchObject([
      { extensions: { code: 'ACCESS_DENIED' } },
    ]);
  });

  it('changes nothing for abandoned sessions and refuses a second commit', async () => {
    const { shop, order, tote, black, send, begin, stage, commit } =
      await setup();
    const abandoned = await begin();
    await stage(abandoned, tote.id, 0);
    expect(shop.events).toHaveLength(0);
    expect(await readStock(shop.context(), '11', '1')).toMatchObject({
      committed: 2,
    });

    const id = await begin();
    await stage(id, black.id, 0);
    await commit(id);
    const after = shop.store.snapshot();
    shop.events.length = 0;
    const again = await commit(id);
    expect(again.committed).toBeUndefined();
    expect(again.body.data?.result).toEqual({
      order: null,
      userErrors: [
        { field: ['id'], message: 'The order edit was already committed.' },
      ],
    });
    expect(shop.store.snapshot()).toEqual(after);
    expect(shop.events).toHaveLength(0);
    const read = await send(readQuery, { id: order.gid });
    expect(read.body.data?.node).toMatchObject({
      lineItems: {
        nodes: [{ currentQuantity: 2 }, { currentQuantity: 0 }],
      },
    });
  });

  it('checks staged changes against the records at commit', async () => {
    const { shop, order, tote, black, send, begin, stage, commit } =
      await setup();
    const other = await shop.order();
    const shipped = await begin();
    await stage(shipped, tote.id, 0);
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      lines: [{ lineItem: tote.id, quantity: 1 }],
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://tracking.example/1',
    });
    const changed = await begin();
    await stage(changed, black.id, 0);
    await shop.run({
      kind: 'order-edit',
      order: order.id,
      lines: [{ lineItem: black.id, quantity: 0 }],
    });
    const { body } = await send(beginMutation, { id: other.gid });
    const cancelled = (body.data?.result?.calculatedOrder as { id: string }).id;
    await stage(cancelled, other.lines![0]!.id, 0);
    await shop.run({ kind: 'cancel', order: other.id, reason: 'CUSTOMER' });
    const before = shop.store.snapshot();
    shop.events.length = 0;

    for (const [id, message] of [
      [shipped, 'Shipped units cannot be removed'],
      [changed, 'The order line changed after the edit was calculated.'],
      [cancelled, 'The order cannot be edited'],
    ] as const) {
      const response = await commit(id);
      expect(response.committed).toBeUndefined();
      expect(response.body.data?.result).toMatchObject({
        order: null,
        userErrors: [{ message }],
      });
    }
    expect(shop.store.snapshot()).toEqual(before);
    expect(shop.events).toHaveLength(0);
  });

  it('lists agreements oldest first or newest first and filters by happened_at', async () => {
    const { shop, order, tote, black, send, begin, stage, commit } =
      await setup();
    await shop.run({
      kind: 'order-edit',
      order: order.id,
      lines: [{ lineItem: tote.id, quantity: 1 }],
    });
    shop.advance(60_000);
    const id = await begin();
    await stage(id, black.id, 0);
    await commit(id);
    const second = new Date(shop.now).toISOString();
    const apps = async (query: string | null, reverse: boolean) => {
      const { body } = await send(
        `query($id: ID!, $query: String, $reverse: Boolean) { node(id: $id) { ... on Order { agreements(first: 5, reverse: $reverse, query: $query) { nodes { app { id } sales(first: 5) { nodes { quantity } } } } } } }`,
        { id: order.gid, query, reverse },
      );
      expect(body.errors).toBeUndefined();
      const node = body.data?.node as {
        agreements: { nodes: { app: { id: string } | null }[] };
      };

      return node.agreements.nodes.map(
        (agreement) => agreement.app?.id ?? null,
      );
    };

    expect(await apps(null, false)).toEqual([null, simulatorAppId]);
    expect(await apps(null, true)).toEqual([simulatorAppId, null]);
    expect(await apps('status:open', false)).toEqual([null, simulatorAppId]);
    expect(await apps(`happened_at:>=${second}`, false)).toEqual([
      simulatorAppId,
    ]);
    expect(await apps(`happened_at:>="${second}"`, false)).toEqual([
      simulatorAppId,
    ]);
    expect(await apps(`happened_at:>'${second}'`, false)).toEqual([]);
  });

  it('identifies order edit operations', () => {
    const identify = (query: string) =>
      shopify.identify(
        graphqlRequest(query, { id: 'gid://shopify/CalculatedOrder/5' }),
      );

    expect(identify(beginMutation)).toEqual({
      operation: 'orders.quantity.calculate',
      resource: 'gid://shopify/CalculatedOrder/5',
      write: true,
    });
    expect(identify(lumaSetQuantityMutation)).toMatchObject({
      operation: 'orders.quantity.calculate',
      write: true,
    });
    expect(identify(commitMutation)).toMatchObject({
      operation: 'orders.quantity.edit',
      write: true,
    });
    expect(identify(readQuery)).toMatchObject({
      operation: 'orders.quantity.read',
      write: false,
    });
    expect(identify(proofQuery)).toMatchObject({
      operation: 'orders.quantity.read',
      write: false,
    });
  });
});
