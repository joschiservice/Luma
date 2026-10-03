import { describe, expect, it } from 'vitest';

import { jtl, readItemStock, supplierEvents } from './index.js';
import type { PurchaseOrderRecord } from './records.js';
import { call, request, seeded, start } from './test-support/fixture.js';

const created = Date.parse('2026-10-01T10:00:00Z');

const body = {
  supplierId: '1',
  requestedDeliveryDate: '2026-10-12T12:00:00Z',
  items: [
    {
      itemId: '1',
      quantity: 10,
      netPurchasePriceAmount: 9.5,
      vatRatePercentage: 19,
    },
  ],
  externalOrderNumber: 'PO-7',
  internalComment: 'Created by Luma · luma-po:po-7',
};

describe('JTL purchasing', () => {
  it('creates orders once per idempotency key and serves list and detail', async () => {
    const { context, events } = await seeded();
    context.wallTime = created;
    const post = (key: string) =>
      call(context, 'purchase-orders', 'POST', body, {
        'idempotency-key': key,
      });
    expect(await post('k')).toMatchObject({
      status: 201,
      body: { purchaseOrderId: 1 },
      committed: true,
    });
    expect(events).toEqual([
      {
        topic: 'purchase-orders/create',
        resource: '1',
        payload: {
          purchaseOrderId: '1',
          supplierEvents: [
            expect.objectContaining({ delay: 20000 }),
            expect.objectContaining({ delay: 60000 }),
          ],
        },
      },
    ]);
    expect(await post('k')).toEqual({
      status: 201,
      body: { purchaseOrderId: 1 },
      headers: { 'content-type': 'application/json' },
    });
    expect(events).toHaveLength(1);
    context.wallTime = created + 5000;
    await post('other');

    const list = await call(
      context,
      'purchase-orders?createdAtAfter=2026-10-01T10:00:00Z&pageNumber=1&pageSize=10',
    );
    expect(list.body).toMatchObject({
      totalItems: 1,
      items: [
        {
          purchaseOrderId: 2,
          supplierName: 'Nordwind Textil GmbH',
          createdAt: '2026-10-01T10:00:05.000Z',
          warehouseId: 1,
        },
      ],
    });
    expect(
      (
        await call(
          context,
          'purchase-orders?createdAtBefore=2026-10-01T10:00:01Z',
        )
      ).body,
    ).toMatchObject({ totalItems: 1, items: [{ purchaseOrderId: 1 }] });
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      purchaseOrderId: 1,
      supplierId: 1,
      supplierName: 'Nordwind Textil GmbH',
      orderNumber: 'BE-00001',
      status: 0,
      isConfirmed: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      internalComment: 'Created by Luma · luma-po:po-7',
      lineItems: [
        {
          lineItemId: 1001,
          lineItemType: 1,
          itemId: 1,
          itemNumber: 'LUMA-001',
          quantity: 10,
          deliveredQuantity: 0,
          openQuantity: 10,
          confirmedQuantity: null,
        },
      ],
    });
    expect((await call(context, 'purchase-orders/9')).status).toBe(404);
    expect(
      (await call(context, 'purchase-orders?createdAtAfter=soon')).status,
    ).toBe(400);
  });

  it('stamps creation with simulation time when it is ahead of the wall clock', async () => {
    const { context } = await seeded();
    context.wallTime = start - 60000;
    await call(context, 'purchase-orders', 'POST', body);
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      createdAt: new Date(start).toISOString(),
    });
  });

  it('rejects unknown suppliers, unassigned items and invalid bodies', async () => {
    const { context, events } = await seeded();
    for (const value of [
      { ...body, supplierId: '9' },
      { ...body, supplierId: '2', items: [{ ...body.items[0], itemId: '2' }] },
      { ...body, items: [] },
      { ...body, requestedDeliveryDate: 'soon' },
      { ...body, items: [{ ...body.items[0], quantity: 0 }] },
      { ...body, internalComment: 7 },
    ])
      expect(
        (
          await call(context, 'purchase-orders', 'POST', value, {
            'idempotency-key': 'k',
          })
        ).status,
      ).toBe(400);
    const malformed = await jtl.handle(context, {
      ...request('purchase-orders', 'POST'),
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(
      (await call(context, 'purchase-orders?pageNumber=1&pageSize=10')).body,
    ).toMatchObject({ totalItems: 0 });
    expect(events).toEqual([]);
    // The rejected key was not recorded, so a valid retry creates the order.
    expect(
      await call(context, 'purchase-orders', 'POST', body, {
        'idempotency-key': 'k',
      }),
    ).toMatchObject({ status: 201, committed: true });
  });

  it('serves active suppliers, supplier detail and item assignments', async () => {
    const { context } = await seeded();
    expect(
      (await call(context, 'suppliers?pageNumber=1&pageSize=10')).body,
    ).toMatchObject({
      totalItems: 2,
      items: [
        {
          id: 1,
          companyName: 'Nordwind Textil GmbH',
          supplierNumber: 'L-1001',
        },
        { id: 2 },
      ],
    });
    expect((await call(context, 'suppliers/2')).body).toMatchObject({
      id: 2,
      isActive: true,
      contact: { emailAddress: 'purchasing@baltic-packaging.example' },
    });
    expect(
      (await call(context, 'items/1/suppliers?pageNumber=1&pageSize=10')).body,
    ).toMatchObject({
      totalItems: 2,
      items: [
        {
          id: 1,
          itemId: 1,
          supplierId: 1,
          supplierName: 'Nordwind Textil GmbH',
          netPurchasePrice: 9.5,
          vatRate: 19,
          isDefaultSupplier: true,
        },
        { id: 2, supplierId: 2, netPurchasePrice: 10.2 },
      ],
    });
    expect((await call(context, 'items/9/suppliers')).status).toBe(404);
    expect((await call(context, 'suppliers/9')).status).toBe(404);
  });

  it('records confirmations and goods receipts, adding stock to the warehouse', async () => {
    const { context, events } = await seeded();
    await call(context, 'purchase-orders', 'POST', body);
    await jtl.command(context, {
      kind: 'purchase-order-confirm',
      orderId: '1',
      lines: [{ lineItemId: '1001', quantity: 8, deliveryDate: '2026-10-15' }],
    });
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      isConfirmed: true,
      lineItems: [
        {
          confirmedQuantity: 8,
          confirmedDeliveryDate: '2026-10-15T00:00:00Z',
          isLineItemConfirmed: true,
        },
      ],
    });
    const receive = (quantity: number, warehouse?: string) =>
      jtl.command(context, {
        kind: 'purchase-order-receive',
        orderId: '1',
        ...(warehouse ? { warehouse } : {}),
        lines: [{ lineItemId: '1001', quantity }],
      });
    context.now += 2000;
    await receive(4);
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      status: 30,
      lineItems: [{ deliveredQuantity: 4, openQuantity: 6 }],
    });
    expect(await readItemStock(context, '1')).toMatchObject({
      total: 124,
      warehouses: { '1': 104, '2': 20 },
    });
    expect(events.at(-1)).toMatchObject({
      topic: 'items/stock',
      resource: '1',
    });
    await expect(receive(7)).rejects.toThrow('Invalid goods receipt');
    await receive(6, '2');
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      status: 500,
    });
    expect((await readItemStock(context, '1'))?.warehouses).toEqual({
      '1': 104,
      '2': 26,
    });
    await expect(receive(1)).rejects.toThrow('completed');
  });

  it('places merchant orders priced from assignments under the supplier profile', async () => {
    const { context } = await seeded();
    await jtl.command(context, {
      kind: 'supplier-profile',
      supplierId: '1',
      profile: 'silent',
    });
    const result = await jtl.command(context, {
      kind: 'purchase-order',
      supplierId: '1',
      deliveryDate: '2026-10-20',
      lines: [
        { itemId: '1', quantity: 12 },
        { itemId: '2', quantity: 3 },
      ],
    });
    expect(result).toEqual({
      id: '1',
      lines: [
        { id: '1001', itemId: '1', quantity: 12 },
        { id: '1002', itemId: '2', quantity: 3 },
      ],
      supplierEvents: [],
    });
    expect((await call(context, 'purchase-orders/1')).body).toMatchObject({
      externalOrderNumber: null,
      internalComment: null,
      lineItems: [
        { netPurchasePriceAmount: 9.5, vatRatePercentage: 19 },
        { netPurchasePriceAmount: 21 },
      ],
    });
    await jtl.command(context, {
      kind: 'supplier-profile',
      supplierId: '1',
      profile: 'delayed',
    });
    const delayed = await jtl.command(context, {
      kind: 'purchase-order',
      supplierId: '1',
      deliveryDate: '2026-10-20',
      lines: [{ itemId: '1', quantity: 1 }],
    });
    expect(delayed.supplierEvents?.map((event) => event.delay)).toEqual([
      20000, 180000,
    ]);
    await expect(
      jtl.command(context, {
        kind: 'purchase-order',
        supplierId: '2',
        deliveryDate: '2026-10-20',
        lines: [{ itemId: '2', quantity: 1 }],
      }),
    ).rejects.toThrow('not assigned');
  });

  it('plans supplier answers per profile', async () => {
    const { context } = await seeded();
    await call(context, 'purchase-orders', 'POST', body);
    const placed = (await context.store.get<PurchaseOrderRecord>(
      'purchase-order',
      '1',
    ))!.data;
    const plan = (profile: Parameters<typeof supplierEvents>[1]) =>
      supplierEvents(placed, profile).map(({ delay, command }) => ({
        delay,
        kind: command.kind,
        lines: command.lines,
      }));
    expect(plan('full')).toEqual([
      {
        delay: 20000,
        kind: 'purchase-order-confirm',
        lines: [
          { lineItemId: '1001', quantity: 10, deliveryDate: '2026-10-12' },
        ],
      },
      {
        delay: 60000,
        kind: 'purchase-order-receive',
        lines: [{ lineItemId: '1001', quantity: 10 }],
      },
    ]);
    expect(plan('partial')).toEqual([
      {
        delay: 20000,
        kind: 'purchase-order-confirm',
        lines: [
          { lineItemId: '1001', quantity: 6, deliveryDate: '2026-10-15' },
        ],
      },
      {
        delay: 60000,
        kind: 'purchase-order-receive',
        lines: [{ lineItemId: '1001', quantity: 3 }],
      },
      {
        delay: 90000,
        kind: 'purchase-order-receive',
        lines: [{ lineItemId: '1001', quantity: 3 }],
      },
    ]);
    expect(plan('delayed')).toMatchObject([
      { lines: [{ quantity: 10, deliveryDate: '2026-10-19' }] },
      { delay: 180000, lines: [{ quantity: 10 }] },
    ]);
    expect(plan('short')).toMatchObject([
      { lines: [{ quantity: 10 }] },
      { delay: 60000, lines: [{ quantity: 5 }] },
    ]);
    expect(plan('silent')).toEqual([]);
  });
});
