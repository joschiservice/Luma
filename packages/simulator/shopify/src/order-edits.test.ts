import { describe, expect, it } from 'vitest';

import { readStock } from './read.js';
import { catalog, createShop } from './test-support/shop.js';

const orderQuery = `query($id: ID!) { node(id: $id) { ... on Order {
  currentTotalPriceSet { shopMoney { amount } }
  lineItems(first: 10) { nodes { quantity currentQuantity } }
  fulfillmentOrders(first: 10) { nodes { status lineItems(first: 10) { nodes { totalQuantity remainingQuantity } } } }
} } }`;

describe('merchant order edits', () => {
  it('reduces and removes lines, preserves original quantities and releases committed stock', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order();
    shop.advance(1000);
    shop.events.length = 0;
    await shop.run({
      kind: 'order-edit',
      order: order.id,
      lines: [
        { lineItem: order.lines![0]!.id, quantity: 1 },
        { lineItem: order.lines![1]!.id, quantity: 0 },
      ],
    });
    expect(await shop.query(orderQuery, { id: order.gid })).toMatchObject({
      data: {
        node: {
          currentTotalPriceSet: { shopMoney: { amount: '24.0' } },
          lineItems: {
            nodes: [
              { quantity: 2, currentQuantity: 1 },
              { quantity: 1, currentQuantity: 0 },
            ],
          },
          fulfillmentOrders: {
            nodes: [
              {
                status: 'OPEN',
                lineItems: {
                  nodes: [
                    { totalQuantity: 1, remainingQuantity: 1 },
                    { totalQuantity: 0, remainingQuantity: 0 },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 100,
      committed: 1,
      available: 99,
    });
    expect(await readStock(shop.context(), '12', '1')).toEqual({
      onHand: 40,
      committed: 0,
      available: 40,
    });
    expect(shop.events.map((event) => event.topic)).toContain('orders/edited');
    await shop.run({
      kind: 'order-edit',
      order: order.id,
      lines: [{ lineItem: order.lines![0]!.id, quantity: 0 }],
    });
    expect(await shop.query(orderQuery, { id: order.gid })).toMatchObject({
      data: {
        node: { fulfillmentOrders: { nodes: [{ status: 'CANCELLED' }] } },
      },
    });
    expect(shop.events.map((event) => event.topic)).toContain(
      'fulfillment_orders/cancelled',
    );
  });

  it('rejects a batch containing another order line without changing any records or emitting events', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order();
    const other = await shop.order();
    const before = shop.store.snapshot();
    shop.events.length = 0;
    await expect(
      shop.run({
        kind: 'order-edit',
        order: order.id,
        lines: [
          { lineItem: order.lines![0]!.id, quantity: 1 },
          { lineItem: other.lines![0]!.id, quantity: 0 },
        ],
      }),
    ).rejects.toThrow('does not belong');
    expect(shop.store.snapshot()).toEqual(before);
    expect(shop.events).toHaveLength(0);
  });

  it('allows removal of remaining work after partial shipment and refuses to remove shipped units', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    const order = await shop.order();
    const line = order.lines![0]!.id;
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      lines: [{ lineItem: line, quantity: 1 }],
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://tracking.example/1',
    });
    const before = shop.store.snapshot();
    await expect(
      shop.run({
        kind: 'order-edit',
        order: order.id,
        lines: [{ lineItem: line, quantity: 0 }],
      }),
    ).rejects.toThrow('Shipped units');
    expect(shop.store.snapshot()).toEqual(before);
    await shop.run({
      kind: 'order-edit',
      order: order.id,
      lines: [{ lineItem: line, quantity: 1 }],
    });
    expect(await shop.query(orderQuery, { id: order.gid })).toMatchObject({
      data: {
        node: {
          lineItems: {
            nodes: [
              { quantity: 2, currentQuantity: 1 },
              { quantity: 1, currentQuantity: 1 },
            ],
          },
        },
      },
    });
  });
});
