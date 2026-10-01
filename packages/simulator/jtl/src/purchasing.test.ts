import { describe, expect, it } from 'vitest';

import {
  ensurePurchasing,
  handle,
  identify,
  purchasingCommand,
  seed,
  supplierEvents,
} from './index.js';

const base = 'https://jtl.invalid/api/eazybusiness';

const created = Date.parse('2026-10-01T10:00:00Z');

function request(
  path: string,
  method = 'GET',
  body: unknown = null,
  key?: string,
) {
  return {
    url: `${base}/${path}`,
    method,
    headers: {
      authorization: 'Wawi synthetic',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === null ? null : JSON.stringify(body),
  };
}

const order = {
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

describe('JTL purchasing simulator', () => {
  it('creates orders once per idempotency key and serves list and detail', () => {
    const state = seed();
    const first = handle(
      state,
      request('purchase-orders', 'POST', order, 'k'),
      0,
      created,
    );
    expect(first).toMatchObject({
      status: 201,
      body: { purchaseOrderId: '1' },
      committed: true,
    });
    const replay = handle(
      state,
      request('purchase-orders', 'POST', order, 'k'),
      0,
      created,
    );
    expect(replay).toEqual({
      status: 201,
      body: { purchaseOrderId: '1' },
      headers: { 'content-type': 'application/json' },
    });
    expect(state.purchaseOrders).toHaveLength(1);
    handle(
      state,
      request('purchase-orders', 'POST', order, 'other'),
      0,
      created + 5000,
    );

    expect(
      handle(
        state,
        request(
          'purchase-orders?createdAtAfter=2026-10-01T10:00:00Z&pageNumber=1&pageSize=10',
        ),
        0,
      ).body,
    ).toMatchObject({ totalItems: 1, items: [{ purchaseOrderId: '2' }] });
    expect(handle(state, request('purchase-orders/1'), 0).body).toMatchObject({
      purchaseOrderId: '1',
      supplierId: '1',
      status: 0,
      isConfirmed: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      internalComment: 'Created by Luma · luma-po:po-7',
      lineItems: [
        {
          lineItemId: '1001',
          lineItemType: 1,
          itemId: '1',
          itemNumber: 'LUMA-001',
          quantity: 10,
          deliveredQuantity: 0,
          openQuantity: 10,
          confirmedQuantity: null,
        },
      ],
    });
    expect(handle(state, request('purchase-orders/9'), 0).status).toBe(404);
  });

  it('rejects unknown suppliers, unassigned items and invalid bodies', () => {
    const state = seed();
    for (const body of [
      { ...order, supplierId: '9' },
      {
        ...order,
        supplierId: '2',
        items: [{ ...order.items[0], itemId: '2' }],
      },
      { ...order, items: [] },
      { ...order, requestedDeliveryDate: 'soon' },
      { ...order, items: [{ ...order.items[0], quantity: 0 }] },
    ])
      expect(
        handle(state, request('purchase-orders', 'POST', body, 'k'), 0).status,
      ).toBe(400);
    expect(state.purchaseOrders).toEqual([]);
    expect(state.purchaseOrderKeys).toEqual([]);
  });

  it('serves active suppliers, supplier detail and item assignments', () => {
    const state = seed();
    state.suppliers[1]!.isActive = false;
    expect(
      handle(state, request('suppliers?pageNumber=1&pageSize=10'), 0).body,
    ).toMatchObject({
      totalItems: 1,
      items: [{ id: '1', companyName: 'Nordwind Textil GmbH' }],
    });
    expect(handle(state, request('suppliers/2'), 0).body).toMatchObject({
      id: '2',
      isActive: false,
      contact: { emailAddress: 'purchasing@baltic-packaging.example' },
    });
    expect(
      handle(state, request('items/1/suppliers?pageNumber=1&pageSize=10'), 0)
        .body,
    ).toMatchObject({
      totalItems: 2,
      items: [
        { supplierId: '1', netPurchasePrice: 9.5, vatRate: 19 },
        { supplierId: '2', netPurchasePrice: 10.2 },
      ],
    });
  });

  it('records confirmations and goods receipts, adding received stock', () => {
    const state = seed();
    handle(state, request('purchase-orders', 'POST', order, 'k'), 0, created);
    purchasingCommand(
      state,
      {
        kind: 'purchase-order-confirm',
        orderId: '1',
        lines: [
          { lineItemId: '1001', quantity: 8, deliveryDate: '2026-10-15' },
        ],
      },
      1000,
    );
    expect(state.purchaseOrders[0]).toMatchObject({
      isConfirmed: true,
      lineItems: [
        {
          confirmedQuantity: 8,
          confirmedDeliveryDate: '2026-10-15T00:00:00Z',
          isLineItemConfirmed: true,
        },
      ],
    });
    const receive = (quantity: number) =>
      purchasingCommand(
        state,
        {
          kind: 'purchase-order-receive',
          orderId: '1',
          lines: [{ lineItemId: '1001', quantity }],
        },
        2000,
      );
    receive(4);
    expect(state.purchaseOrders[0]).toMatchObject({
      status: 30,
      lineItems: [{ deliveredQuantity: 4, openQuantity: 6 }],
    });
    expect(state.items[0]).toMatchObject({
      stockTotal: '104',
      stockAvailable: '104',
      modifiedTimestamp: new Date(2000).toISOString(),
    });
    expect(() => receive(7)).toThrow('Invalid goods receipt');
    receive(6);
    expect(state.purchaseOrders[0]!.status).toBe(500);
    expect(state.items[0]!.stockTotal).toBe('110');
    expect(() => receive(1)).toThrow('completed');
  });

  it('plans supplier answers per profile', () => {
    const state = seed();
    handle(state, request('purchase-orders', 'POST', order, 'k'), 0, created);
    const placed = state.purchaseOrders[0]!;
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

  it('names purchasing operations for fault targeting', () => {
    expect(identify(request('purchase-orders', 'POST'))).toEqual({
      operation: 'purchase-orders.submit',
    });
    expect(identify(request('purchase-orders/4'))).toEqual({
      operation: 'purchase-orders.read',
      resource: '4',
    });
    expect(identify(request('suppliers/2'))).toEqual({
      operation: 'suppliers.read',
      resource: '2',
    });
    expect(identify(request('items/1/suppliers'))).toEqual({
      operation: 'items.read',
      resource: '1',
    });
  });

  it('backfills purchasing for state saved before it was simulated', () => {
    const legacy: Partial<ReturnType<typeof seed>> = seed();
    delete legacy.suppliers;
    delete legacy.itemSuppliers;
    delete legacy.purchaseOrders;
    delete legacy.purchaseOrderKeys;
    delete legacy.supplierProfiles;
    ensurePurchasing(legacy);
    expect(legacy).toMatchObject({
      suppliers: [{ id: '1' }, { id: '2' }],
      purchaseOrders: [],
      purchaseOrderKeys: [],
      supplierProfiles: {},
    });
  });
});
