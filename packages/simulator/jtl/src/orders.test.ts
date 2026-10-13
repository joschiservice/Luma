import { describe, expect, it } from 'vitest';

import { jtl, openOrders, readItemStock, readOrder } from './index.js';
import { call, order, seeded, start } from './test-support/fixture.js';

const ship = (
  context: Parameters<typeof order>[0],
  lines?: { lineId: string; quantity: number }[],
  warehouse = '1',
) =>
  jtl.command(context, {
    kind: 'ship',
    id: '1',
    warehouse,
    ...(lines ? { lines } : {}),
    trackingNumber: 'JJD000000000001',
    trackingUrl: 'https://tracking.example.test/JJD000000000001',
  });

describe('JTL sales orders', () => {
  it('reserves stock for new orders and numbers them like JTL', async () => {
    const { context, events } = await seeded();
    const placed = await order(context);
    expect(placed).toEqual({
      id: '1',
      lines: [{ id: '1', itemId: '1', quantity: 3 }],
    });
    expect(await readItemStock(context, '1')).toEqual({
      total: 120,
      reserved: 3,
      available: 117,
      warehouses: { '1': 100, '2': 20 },
    });
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      id: 1,
      salesOrderNumber: 'AU-000001',
      salesOrderDate: new Date(start).toISOString(),
      externalDetails: { externalSalesOrderNumber: '#1001' },
      paymentDetails: { currencyIso: 'EUR' },
      shippingDetails: { shippingDate: null },
      keyFigures: {
        salesOrderId: 1,
        deliveryStatus: 1,
        paymentStatus: 2,
        totalGrossAmount: 72,
      },
    });
    expect(events.map((event) => event.topic)).toEqual([
      'sales-orders/create',
      'items/stock',
    ]);
    expect(await readItemStock(context, '9')).toBeUndefined();
  });

  it('keeps explicit fixture IDs and skips them when allocating', async () => {
    const { context } = await seeded();
    await order(context, 1, '2');
    await expect(order(context, 1, '2')).rejects.toThrow('already exists');
    await expect(order(context, 1, 'x')).rejects.toThrow('Invalid');
    expect((await order(context)).id).toBe('1');
    expect((await order(context)).id).toBe('3');
    await expect(
      jtl.command(context, {
        kind: 'order',
        lines: [{ itemId: '404', quantity: 1, price: 1 }],
        shippingMethodId: '7',
        currency: 'EUR',
        paid: false,
      }),
    ).rejects.toThrow('Item not found');
  });

  it('advances the item modification time strictly on every stock change', async () => {
    const { context } = await seeded();
    const modified = async () =>
      ((await call(context, 'items/1')).body as { modifiedTimestamp: string })
        .modifiedTimestamp;
    await order(context, 1);
    const first = await modified();
    await order(context, 1);
    const second = await modified();
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    context.now += 60000;
    await jtl.command(context, {
      kind: 'stock',
      itemId: '1',
      warehouse: '2',
      quantity: 7,
    });
    expect(await modified()).toBe(new Date(context.now).toISOString());
    expect((await readItemStock(context, '1'))?.warehouses).toEqual({
      '1': 100,
      '2': 7,
    });
    await expect(
      jtl.command(context, {
        kind: 'stock',
        itemId: '1',
        warehouse: '3',
        quantity: 1,
      }),
    ).rejects.toThrow('Warehouse not found');
    await expect(
      jtl.command(context, {
        kind: 'stock',
        itemId: '1',
        warehouse: '1',
        quantity: -1,
      }),
    ).rejects.toThrow('Invalid stock');
  });

  it('ships partially from a warehouse and closes the order on the last unit', async () => {
    const { context, events } = await seeded();
    await order(context);
    context.now += 1000;
    await expect(ship(context, [{ lineId: '1', quantity: 4 }])).rejects.toThrow(
      'open quantity',
    );
    await expect(ship(context, [{ lineId: '9', quantity: 1 }])).rejects.toThrow(
      'line not found',
    );
    events.length = 0;
    expect(await ship(context, [{ lineId: '1', quantity: 1 }], '2')).toEqual({
      id: '1',
      lines: [{ id: '1', itemId: '1', quantity: 1 }],
    });
    expect(events.map((event) => event.topic)).toEqual([
      'delivery-notes/create',
      'sales-orders/update',
      'items/stock',
    ]);
    expect(await readItemStock(context, '1')).toEqual({
      total: 119,
      reserved: 2,
      available: 117,
      warehouses: { '1': 100, '2': 19 },
    });
    expect(await readOrder(context, '1')).toMatchObject({
      deliveryStatus: 3,
      warehouse: '2',
      lines: [{ id: '1', quantity: 3, open: 2 }],
    });
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      keyFigures: { deliveryStatus: 3 },
      shippingDetails: { shippingDate: new Date(start + 1000).toISOString() },
    });
    context.now += 1000;
    expect(await ship(context)).toMatchObject({
      id: '2',
      lines: [{ id: '1', quantity: 2 }],
    });
    expect(await readOrder(context, '1')).toMatchObject({
      deliveryStatus: 5,
      warehouse: '1',
      lines: [{ open: 0 }],
    });
    expect(await readItemStock(context, '1')).toMatchObject({
      total: 117,
      reserved: 0,
      warehouses: { '1': 98, '2': 19 },
    });
    await expect(ship(context)).rejects.toThrow('Nothing to ship');
    await expect(
      jtl.command(context, { kind: 'cancel', id: '1' }),
    ).rejects.toThrow('has shipped');
  });

  it('removes a delivery note that is still being packed and returns its units', async () => {
    const { context, events } = await seeded();
    await order(context);
    const before = await readItemStock(context, '1');
    await expect(
      jtl.command(context, { kind: 'unpack', id: '1' }),
    ).rejects.toThrow('No delivery note');
    context.now += 1000;
    await jtl.command(context, {
      kind: 'ship',
      id: '1',
      warehouse: '1',
      lines: [{ lineId: '1', quantity: 2 }],
      trackingNumber: 'JJD000000000001',
      trackingUrl: 'https://tracking.example.test/JJD000000000001',
      packing: true,
    });
    expect(
      (await call(context, 'delivery-notes?pageNumber=1&pageSize=10')).body,
    ).toMatchObject({ totalItems: 1 });
    events.length = 0;
    context.now += 1000;
    expect(await jtl.command(context, { kind: 'unpack', id: '1' })).toEqual({
      id: '1',
      deliveryNotes: ['1'],
    });
    expect(events.map((event) => event.topic)).toEqual([
      'delivery-notes/delete',
      'sales-orders/update',
      'items/stock',
    ]);
    expect(
      (await call(context, 'delivery-notes?pageNumber=1&pageSize=10')).body,
    ).toMatchObject({ totalItems: 0 });
    expect(await readItemStock(context, '1')).toEqual(before);
    expect(await readOrder(context, '1')).toMatchObject({
      deliveryStatus: 1,
      lines: [{ id: '1', quantity: 3, open: 3 }],
    });
  });

  it('refuses shipments the warehouse cannot cover', async () => {
    const { context } = await seeded();
    await jtl.command(context, {
      kind: 'order',
      lines: [
        { itemId: '2', quantity: 4, price: 59.9 },
        { itemId: '2', quantity: 2, price: 59.9 },
      ],
      shippingMethodId: '7',
      currency: 'EUR',
      paid: false,
    });
    expect(await readItemStock(context, '2')).toMatchObject({
      total: 5,
      reserved: 6,
      available: -1,
    });
    await expect(ship(context)).rejects.toThrow('Insufficient stock');
    await expect(ship(context, undefined, '2')).rejects.toThrow(
      'Insufficient stock',
    );
    expect((await readOrder(context, '1'))?.deliveryStatus).toBe(1);
    await ship(context, [{ lineId: '1', quantity: 4 }]);
    expect(await readItemStock(context, '2')).toMatchObject({
      total: 1,
      reserved: 2,
      available: -1,
    });
  });

  it('cancels unshipped orders, releasing reservations, and records payment', async () => {
    const { context } = await seeded();
    await jtl.command(context, {
      kind: 'order',
      lines: [{ itemId: '1', quantity: 2, price: 24 }],
      shippingMethodId: '7',
      currency: 'EUR',
      paid: false,
    });
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      keyFigures: { paymentStatus: 0 },
    });
    await jtl.command(context, { kind: 'paid', id: '1' });
    expect(await readOrder(context, '1')).toMatchObject({ paid: true });
    await jtl.command(context, { kind: 'cancel', id: '1' });
    expect(await readItemStock(context, '1')).toMatchObject({
      reserved: 0,
      available: 120,
    });
    expect(await readOrder(context, '1')).toMatchObject({
      cancelled: true,
      lines: [{ open: 0 }],
    });
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      isCancelled: true,
    });
    await expect(
      jtl.command(context, { kind: 'cancel', id: '1' }),
    ).rejects.toThrow('already cancelled');
    await expect(ship(context)).rejects.toThrow('cancelled');
    await expect(
      jtl.command(context, {
        kind: 'shipping-method',
        id: '1',
        shippingMethodId: '8',
      }),
    ).rejects.toThrow('cancelled');
    await expect(
      jtl.command(context, { kind: 'paid', id: '9' }),
    ).rejects.toThrow('not found');
  });

  it('pages open orders oldest first and drops closed ones', async () => {
    const { context } = await seeded();
    for (let index = 0; index < 5; index++) {
      await order(context, 1);
      context.now += 1000;
    }
    await jtl.command(context, { kind: 'cancel', id: '2' });
    await jtl.command(context, {
      kind: 'ship',
      id: '4',
      warehouse: '1',
      trackingNumber: 'T',
      trackingUrl: 'https://tracking.example.test/T',
    });
    const first = await openOrders(context, { limit: 2 });
    expect(first.orders.map((value) => value.id)).toEqual(['1', '3']);
    expect(first.orders[1]).toMatchObject({
      externalNumber: '#1001',
      cancelled: false,
      deliveryStatus: 1,
      paid: true,
      warehouse: null,
      shippingMethodId: '7',
      createdAt: start + 2000,
      lines: [{ itemId: '1', quantity: 1, open: 1 }],
    });
    const rest = await openOrders(context, { limit: 2, after: first.next });
    expect(rest.orders.map((value) => value.id)).toEqual(['5']);
    expect(rest.next).toBeNull();
  });
});
