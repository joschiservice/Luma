import { beforeEach, describe, expect, it } from 'vitest';

import { readOrder, readStock } from './read.js';
import { catalog, createShop } from './test-support/shop.js';

const topics = (shop: ReturnType<typeof createShop>) =>
  shop.events.map((event) => event.topic);

describe('orders', () => {
  let shop: ReturnType<typeof createShop>;

  beforeEach(async () => {
    shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
  });

  it('commits stock, opens one fulfillment order and updates the customer', async () => {
    const customer = await shop.run({
      kind: 'customer',
      customer: {
        firstName: 'Anna',
        lastName: 'Müller',
        email: 'Anna@Customer.example',
        phone: '+49 151 0000001',
        address: {
          address1: 'Hauptstraße 1',
          city: 'Berlin',
          zip: '10115',
          countryCode: 'DE',
        },
      },
    });
    shop.events.length = 0;
    const order = await shop.order({
      customer: customer.id,
      shipping: 'express',
    });

    expect(order.name).toBe('#T1001');
    expect(order.lines).toEqual([
      { id: expect.any(String), variant: '11', quantity: 2 },
      { id: expect.any(String), variant: '12', quantity: 1 },
    ]);
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 100,
      committed: 2,
      available: 98,
    });
    const view = await readOrder(shop.context(), order.id);
    expect(view).toMatchObject({
      gid: `gid://shopify/Order/${order.id}`,
      name: '#T1001',
      createdAt: shop.now,
      cancelled: false,
      closed: false,
      financialStatus: 'PAID',
      customer: customer.id,
      location: '1',
      shipping: 'express',
      holds: [],
      fulfillments: [],
      returnStatus: null,
      refunds: [],
    });
    expect(view?.lines.map((line) => line.unfulfilled)).toEqual([2, 1]);
    const work = await shop.store.page({
      kind: 'FulfillmentOrder',
      parent: order.id,
      limit: 5,
    });
    expect(work.items).toHaveLength(1);
    expect(work.items[0]?.data).toMatchObject({
      status: 'OPEN',
      location: '1',
      fulfillBy: new Date(shop.now + 2 * 86_400_000)
        .toISOString()
        .replace('.000', ''),
      method: { name: 'Express' },
    });
    expect((await shop.store.get('Customer', customer.id))?.data).toMatchObject(
      {
        numberOfOrders: 1,
        amountSpent: 7450,
      },
    );
    expect(topics(shop)).toEqual([
      'inventory_levels/update',
      'inventory_levels/update',
      'customers/update',
      'orders/create',
    ]);
    expect(shop.events.at(-1)).toEqual({
      topic: 'orders/create',
      resource: `gid://shopify/Order/${order.id}`,
      payload: {
        id: Number(order.id),
        admin_graphql_api_id: `gid://shopify/Order/${order.id}`,
        updated_at: '2026-09-01T08:00:00Z',
        name: '#T1001',
      },
    });
    await expect(
      shop.run({
        kind: 'customer',
        customer: {
          firstName: 'Other',
          lastName: 'Person',
          email: 'anna@customer.example',
          phone: '',
          address: { address1: '', city: '', zip: '', countryCode: 'DE' },
        },
      }),
    ).rejects.toThrow('Email has already been taken');
  });

  it('numbers orders per shop and accepts explicit fixture IDs', async () => {
    const fixture = await shop.order({ id: '7' });
    const next = await shop.order();

    expect(fixture).toMatchObject({
      id: '7',
      name: '#T7',
      gid: 'gid://shopify/Order/7',
    });
    expect(next.name).toBe('#T1001');
    await expect(shop.order({ id: '7' })).rejects.toThrow('already exists');
    await expect(
      shop.order({
        lines: [{ variant: '12', quantity: 1, price: '26.50' }],
        location: '2',
      }),
    ).rejects.toThrow('not stocked');
  });

  it('cancels unfulfilled orders, releasing stock and refunding payment', async () => {
    const order = await shop.order();
    shop.advance(60_000);
    shop.events.length = 0;
    await shop.run({ kind: 'cancel', order: order.id, reason: 'CUSTOMER' });

    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 100,
      committed: 0,
      available: 100,
    });
    expect(await readOrder(shop.context(), order.id)).toMatchObject({
      cancelled: true,
      closed: true,
      financialStatus: 'REFUNDED',
      refunds: [{ status: 'SUCCESS' }],
    });
    expect(topics(shop)).toEqual([
      'inventory_levels/update',
      'inventory_levels/update',
      'orders/updated',
      'orders/cancelled',
      'refunds/create',
    ]);
    await expect(
      shop.run({ kind: 'cancel', order: order.id, reason: 'CUSTOMER' }),
    ).rejects.toThrow('already cancelled');

    const shipped = await shop.order();
    await shop.run({
      kind: 'fulfill',
      order: shipped.id,
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://track.example/1',
    });
    await expect(
      shop.run({ kind: 'cancel', order: shipped.id, reason: 'CUSTOMER' }),
    ).rejects.toThrow('with fulfillments');

    const pending = await shop.order({ financialStatus: 'PENDING' });
    await shop.run({ kind: 'cancel', order: pending.id, reason: 'DECLINED' });
    expect(await readOrder(shop.context(), pending.id)).toMatchObject({
      financialStatus: 'VOIDED',
      refunds: [],
    });
  });

  it('marks pending orders paid', async () => {
    const order = await shop.order({ financialStatus: 'PENDING' });
    shop.events.length = 0;
    await shop.run({ kind: 'paid', order: order.id });

    expect((await readOrder(shop.context(), order.id))?.financialStatus).toBe(
      'PAID',
    );
    expect(topics(shop)).toEqual(['orders/updated', 'orders/paid']);
    await expect(shop.run({ kind: 'paid', order: order.id })).rejects.toThrow(
      'not awaiting payment',
    );
  });

  it('holds and releases fulfillment without changing stock', async () => {
    const order = await shop.order({ holds: ['HIGH_RISK_OF_FRAUD'] });
    expect((await readOrder(shop.context(), order.id))?.holds).toEqual([
      'HIGH_RISK_OF_FRAUD',
    ]);
    shop.advance(1000);
    shop.events.length = 0;
    await shop.run({
      kind: 'hold',
      order: order.id,
      reason: 'INCORRECT_ADDRESS',
    });
    expect(topics(shop)).toEqual([
      'fulfillment_orders/placed_on_hold',
      'fulfillment_holds/added',
      'orders/updated',
    ]);
    await expect(
      shop.run({
        kind: 'fulfill',
        order: order.id,
        carrier: 'DHL',
        trackingNumber: '1',
        trackingUrl: 'https://track.example/1',
      }),
    ).rejects.toThrow('Release the fulfillment hold before shipping');
    shop.events.length = 0;
    await shop.run({ kind: 'release', order: order.id });

    const view = await readOrder(shop.context(), order.id);
    expect(view?.holds).toEqual([]);
    expect(topics(shop)).toEqual([
      'fulfillment_holds/released',
      'fulfillment_holds/released',
      'fulfillment_orders/hold_released',
      'orders/updated',
    ]);
    expect(await readStock(shop.context(), '11', '1')).toMatchObject({
      committed: 2,
    });
    await expect(
      shop.run({ kind: 'release', order: order.id }),
    ).rejects.toThrow('not on hold');
  });

  it('fulfills partially, then completely, and tracks the shipment', async () => {
    const order = await shop.order();
    const [tote, black] = order.lines ?? [];
    shop.advance(3_600_000);
    shop.events.length = 0;
    const first = await shop.run({
      kind: 'fulfill',
      order: order.id,
      lines: [{ lineItem: tote!.id, quantity: 1 }],
      carrier: 'DHL',
      trackingNumber: '00340434',
      trackingUrl: 'https://track.example/00340434',
      estimatedDeliveryAt: shop.now + 86_400_000,
    });

    expect(first.lines).toEqual([{ id: tote!.id, variant: '11', quantity: 1 }]);
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 99,
      committed: 1,
      available: 98,
    });
    let view = await readOrder(shop.context(), order.id);
    expect(view?.lines.map((line) => line.unfulfilled)).toEqual([1, 1]);
    expect(view?.closed).toBe(false);
    expect((await shop.store.get('Order', order.id))?.data).toMatchObject({
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    });
    expect(topics(shop)).toEqual([
      'inventory_levels/update',
      'orders/updated',
      'fulfillments/create',
      'orders/partially_fulfilled',
    ]);
    const work = (
      await shop.store.page({
        kind: 'FulfillmentOrder',
        parent: order.id,
        limit: 5,
      })
    ).items[0];
    expect(work?.data).toMatchObject({ status: 'IN_PROGRESS' });

    shop.advance(1000);
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      carrier: 'DHL',
      trackingNumber: '00340435',
      trackingUrl: 'https://track.example/00340435',
    });
    view = await readOrder(shop.context(), order.id);
    expect(view?.closed).toBe(true);
    expect(view?.lines.map((line) => line.unfulfilled)).toEqual([0, 0]);
    expect(view?.fulfillments).toHaveLength(2);
    expect(await readStock(shop.context(), '12', '1')).toEqual({
      onHand: 39,
      committed: 0,
      available: 39,
    });
    expect(
      (await shop.store.get('FulfillmentOrder', work!.id))?.data,
    ).toMatchObject({
      status: 'CLOSED',
    });
    expect((await shop.store.get('Order', order.id))?.updatedAt).toBe(shop.now);
    await expect(
      shop.run({
        kind: 'fulfill',
        order: order.id,
        lines: [{ lineItem: black!.id, quantity: 1 }],
        carrier: 'DHL',
        trackingNumber: '1',
        trackingUrl: 'https://track.example/1',
      }),
    ).rejects.toThrow('fewer unfulfilled units');

    shop.advance(1000);
    shop.events.length = 0;
    await shop.run({
      kind: 'shipment-status',
      fulfillment: first.id,
      status: 'IN_TRANSIT',
    });
    shop.advance(1000);
    await shop.run({
      kind: 'shipment-status',
      fulfillment: first.id,
      status: 'DELIVERED',
    });
    expect((await shop.store.get('Fulfillment', first.id))?.data).toMatchObject(
      {
        status: 'SUCCESS',
        displayStatus: 'DELIVERED',
        inTransitAt: '2026-09-01T09:00:02Z',
        deliveredAt: '2026-09-01T09:00:03Z',
      },
    );
    expect(topics(shop)).toEqual([
      'orders/updated',
      'fulfillments/update',
      'orders/updated',
      'fulfillments/update',
    ]);
    await expect(
      shop.run({
        kind: 'shipment-status',
        fulfillment: first.id,
        status: 'FAILURE',
      }),
    ).rejects.toThrow('delivered');
  });

  it('follows a return through receipt, refund attempts and close', async () => {
    const order = await shop.order();
    const [tote] = order.lines ?? [];
    await expect(
      shop.run({
        kind: 'return',
        order: order.id,
        lines: [{ lineItem: tote!.id, quantity: 1 }],
        reason: 'Too small',
      }),
    ).rejects.toThrow('Ship the order first');
    await shop.run({
      kind: 'fulfill',
      order: order.id,
      carrier: 'DHL',
      trackingNumber: '1',
      trackingUrl: 'https://track.example/1',
    });
    await expect(
      shop.run({
        kind: 'return',
        order: order.id,
        lines: [{ lineItem: tote!.id, quantity: 3 }],
        reason: 'Too small',
      }),
    ).rejects.toThrow('at most the shipped quantity');
    shop.events.length = 0;
    await shop.run({
      kind: 'return',
      order: order.id,
      lines: [{ lineItem: tote!.id, quantity: 2 }],
      reason: 'Too small',
    });
    await expect(
      shop.run({ kind: 'refund', order: order.id, outcome: 'success' }),
    ).rejects.toThrow('Approve the return');
    await shop.run({ kind: 'return-approve', order: order.id });
    await shop.run({ kind: 'return-receive', order: order.id });
    await expect(
      shop.run({ kind: 'return-receive', order: order.id }),
    ).rejects.toThrow('already received');
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 100,
      committed: 0,
      available: 100,
    });
    await shop.run({ kind: 'refund', order: order.id, outcome: 'failure' });
    await shop.run({ kind: 'refund', order: order.id, outcome: 'pending' });
    await expect(
      shop.run({ kind: 'refund', order: order.id, outcome: 'success' }),
    ).rejects.toThrow('Nothing left to refund');
    let view = await readOrder(shop.context(), order.id);
    expect(view?.refunds.map((refund) => refund.status)).toEqual([
      'FAILURE',
      'PENDING',
    ]);
    expect(view?.financialStatus).toBe('PAID');
    await shop.run({ kind: 'refund-settle', order: order.id });
    await shop.run({ kind: 'return-close', order: order.id });

    view = await readOrder(shop.context(), order.id);
    expect(view).toMatchObject({
      returnStatus: 'CLOSED',
      financialStatus: 'PARTIALLY_REFUNDED',
      refunds: [{ status: 'FAILURE' }, { status: 'SUCCESS' }],
    });
    expect((await shop.store.get('Order', order.id))?.data).toMatchObject({
      refunded: 4800,
    });
    expect(topics(shop).filter((topic) => topic !== 'orders/updated')).toEqual([
      'returns/request',
      'returns/approve',
      'inventory_levels/update',
      'reverse_fulfillment_orders/dispose',
      'refunds/create',
      'refunds/create',
      'returns/close',
    ]);

    await shop.run({
      kind: 'return',
      order: order.id,
      lines: [{ lineItem: order.lines![1]!.id, quantity: 1 }],
      reason: 'Changed mind',
    });
    await shop.run({ kind: 'return-decline', order: order.id });
    expect((await readOrder(shop.context(), order.id))?.returnStatus).toBe(
      'DECLINED',
    );
  });
});

describe('catalog and stock', () => {
  it('updates products, on-hand and available stock', async () => {
    const shop = createShop();
    await shop.run({ kind: 'seed-catalog', products: catalog });
    await shop.order();
    shop.advance(1000);
    shop.events.length = 0;

    await shop.run({
      kind: 'available',
      variant: '11',
      location: '1',
      quantity: 10,
    });
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 12,
      committed: 2,
      available: 10,
    });
    await shop.run({
      kind: 'stock',
      variant: '11',
      location: '1',
      quantity: 50,
    });
    expect(await readStock(shop.context(), '11', '1')).toEqual({
      onHand: 50,
      committed: 2,
      available: 48,
    });
    await shop.run({
      kind: 'stock',
      variant: '12',
      location: '2',
      quantity: 3,
    });
    expect(await readStock(shop.context(), '12', '2')).toEqual({
      onHand: 3,
      committed: 0,
      available: 3,
    });
    await expect(
      shop.run({ kind: 'stock', variant: '11', location: '9', quantity: 1 }),
    ).rejects.toThrow('Location 9 not found');

    await shop.run({
      kind: 'product-update',
      product: '10',
      price: '19.99',
      status: 'DRAFT',
      published: false,
    });
    expect((await shop.store.get('Product', '10'))?.data).toMatchObject({
      status: 'DRAFT',
      publishedAt: null,
      minPrice: 1999,
    });
    expect((await shop.store.get('ProductVariant', '12'))?.data).toMatchObject({
      price: 1999,
    });
    expect(shop.events.map((event) => event.topic)).toEqual([
      'inventory_levels/update',
      'inventory_levels/update',
      'inventory_levels/update',
      'products/update',
    ]);
  });

  it('imports 40,000 variants in one bulk write', async () => {
    const shop = createShop();
    const products = Array.from({ length: 10_000 }, (_, product) => ({
      id: String(product + 1),
      title: `Product ${product + 1}`,
      vendor: 'Luma Goods',
      productType: 'Goods',
      published: true,
      variants: Array.from({ length: 4 }, (_, variant) => ({
        id: String(100_000 + product * 4 + variant),
        sku: `SKU-${product}-${variant}`,
        title: `Size ${variant}`,
        price: '10.00',
        barcode: null,
        stock: { '1': 5, '2': 1 },
      })),
    }));
    const started = performance.now();
    await shop.run({ kind: 'seed-catalog', products });

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await shop.store.count({ kind: 'ProductVariant' })).toBe(40_000);
    expect(await shop.store.count({ kind: 'InventoryLevel' })).toBe(80_000);
    expect(shop.events).toEqual([]);
    await expect(
      shop.run({ kind: 'seed-catalog', products: products.slice(0, 1) }),
    ).rejects.toThrow('already exists');
  });
});
