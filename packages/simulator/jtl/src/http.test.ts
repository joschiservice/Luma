import { type Bucket, charge } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { jtl } from './index.js';
import {
  call,
  createFixture,
  order,
  request,
  seeded,
  start,
} from './test-support/fixture.js';

interface Page {
  items: { id: number }[];
  pageNumber: number;
  pageSize: number;
  totalItems: number;
  hasNextPage: boolean;
  nextPageNumber: number;
}

describe('JTL ERP API', () => {
  it('pages lists with exactly consistent metadata and validates parameters', async () => {
    const { context } = await seeded();
    for (let index = 0; index < 5; index++) await order(context, 1);
    const page = async (query: string) =>
      (await call(context, `sales-orders?${query}`)).body as Page;
    expect(await page('pageNumber=1&pageSize=2')).toMatchObject({
      items: [{ id: 1 }, { id: 2 }],
      pageNumber: 1,
      pageSize: 2,
      totalItems: 5,
      hasNextPage: true,
      nextPageNumber: 2,
    });
    expect(await page('pageNumber=3&pageSize=2')).toMatchObject({
      items: [{ id: 5 }],
      hasNextPage: false,
    });
    expect((await page('pageNumber=4&pageSize=2')).items).toEqual([]);
    // Records created while a client pages shift later pages, as in JTL.
    await order(context, 1);
    expect(await page('pageNumber=3&pageSize=2')).toMatchObject({
      items: [{ id: 5 }, { id: 6 }],
      totalItems: 6,
      hasNextPage: false,
    });
    expect((await page('pageSize=1000')).items).toHaveLength(6);
    for (const query of [
      'pageSize=1001',
      'pageSize=0',
      'pageNumber=0',
      'pageNumber=x',
      'pageNumber=1.5',
    ])
      expect((await call(context, `sales-orders?${query}`)).status).toBe(400);
  });

  it('serves sales orders, line items and shipping-method changes', async () => {
    const { context, events } = await seeded();
    await order(context);
    expect((await call(context, 'sales-orders/1/line-items')).body).toEqual([
      {
        id: 1,
        salesOrderId: 1,
        itemId: 1,
        sKU: 'LUMA-001',
        name: 'Canvas tote',
        quantity: 3,
        salesUnit: 'Stück',
        salesPriceGross: 24,
      },
    ]);
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      shippingMethodId: 7,
      isCancelled: false,
    });
    events.length = 0;
    const patch = (id: string, value: unknown) =>
      call(context, `sales-orders/${id}`, 'PATCH', {
        shippingMethodId: value,
        disableAutomaticWorkflows: true,
      });
    expect(await patch('1', '8')).toMatchObject({
      status: 200,
      body: { salesOrderId: 1 },
      committed: true,
    });
    expect(events).toMatchObject([
      { topic: 'sales-orders/update', resource: '1' },
    ]);
    expect((await call(context, 'sales-orders/1')).body).toMatchObject({
      shippingMethodId: 8,
    });
    expect((await patch('1', 99)).status).toBe(400);
    expect((await patch('2', 8)).status).toBe(404);
    await jtl.command(context, { kind: 'cancel', id: '1' });
    expect(await patch('1', 9)).toMatchObject({ status: 409 });
    expect((await call(context, 'sales-orders/x')).status).toBe(404);
    expect((await call(context, 'sales-orders/1/other')).status).toBe(404);
    expect(
      (await call(context, 'shipping-methods?pageNumber=1&pageSize=2')).body,
    ).toMatchObject({
      items: [
        { id: 7, name: 'Standard' },
        { id: 8, name: 'Express' },
      ],
      totalItems: 3,
      hasNextPage: true,
    });
  });

  it('serves items with stock totals and per-warehouse stock', async () => {
    const { context } = await seeded();
    await order(context);
    expect(
      (await call(context, 'items?pageNumber=1&pageSize=1')).body,
    ).toMatchObject({
      items: [
        {
          id: 1,
          sKU: 'LUMA-001',
          name: 'Canvas tote',
          unit: 'Stück',
          isActive: true,
          isShopActive: true,
          isInventoryManagementActive: true,
          salesPriceGross: 24,
          gTIN: '4006381333931',
          manufacturerName: 'Luma Goods',
          stockTotal: 120,
          stockReservedTotal: 3,
          stockAvailable: 117,
          modifiedTimestamp: new Date(start + 1).toISOString(),
        },
      ],
      totalItems: 2,
    });
    expect((await call(context, 'warehouses/2/items/1/stocks')).body).toEqual({
      itemId: 1,
      warehouseId: 2,
      totalQuantity: 20,
      lockedQuantity: 0,
    });
    expect(
      (await call(context, 'warehouses/2/items/2/stocks')).body,
    ).toMatchObject({ totalQuantity: 0 });
    expect((await call(context, 'warehouses/3/items/1/stocks')).status).toBe(
      404,
    );
    expect((await call(context, 'warehouses/1/items/9/stocks')).status).toBe(
      404,
    );
    expect((await call(context, 'warehouses')).body).toMatchObject({
      items: [
        { id: 1, name: 'Hamburg' },
        { id: 2, name: 'Leipzig' },
      ],
    });
  });

  it('serves delivery notes per order with packages and paged lines', async () => {
    const { context } = await seeded();
    await order(context, 3);
    await order(context, 1);
    const ship = (id: string, quantity?: number) =>
      jtl.command(context, {
        kind: 'ship',
        id,
        warehouse: '1',
        ...(quantity ? { lines: [{ lineId: id, quantity }] } : {}),
        trackingNumber: `JJD${id}`,
        trackingUrl: `https://tracking.example.test/JJD${id}`,
      });
    await ship('1', 1);
    await ship('2');
    await ship('1');
    expect(
      (await call(context, 'delivery-notes?salesOrderNumberId=1')).body,
    ).toMatchObject({
      totalItems: 2,
      items: [
        { id: 1, salesOrderId: 1 },
        { id: 3, salesOrderId: 1 },
      ],
    });
    expect((await call(context, 'delivery-notes/3')).body).toEqual({
      id: 3,
      salesOrderId: 1,
      warehouseId: 1,
      deliveryNoteDate: new Date(start).toISOString(),
      packages: [
        {
          id: 3,
          deliveryNoteId: 3,
          shippingDate: new Date(start).toISOString(),
          trackingNumber: 'JJD1',
          trackingUrl: 'https://tracking.example.test/JJD1',
        },
      ],
    });
    expect(
      (
        await call(
          context,
          'delivery-notes/3/line-items?pageNumber=1&pageSize=100',
        )
      ).body,
    ).toMatchObject({
      items: [
        { id: 3, deliveryNoteId: 3, salesOrderLineItemId: 1, quantity: 2 },
      ],
      totalItems: 1,
    });
    expect((await call(context, 'delivery-notes')).body).toMatchObject({
      totalItems: 3,
    });
    expect(
      (await call(context, 'delivery-notes?salesOrderNumberId=abc')).status,
    ).toBe(400);
    expect((await call(context, 'delivery-notes/9')).status).toBe(404);
  });

  it('names operations and resources for fault targeting', () => {
    const target = (path: string, method = 'GET') =>
      jtl.identify(request(path, method));
    expect(target('sales-orders?pageNumber=1')).toEqual({
      operation: 'orders.read',
      resource: undefined,
      write: false,
    });
    expect(target('sales-orders/4/line-items')).toMatchObject({
      operation: 'orders.read',
      resource: '4',
    });
    expect(target('sales-orders/4')).toMatchObject({
      operation: 'orders.shipping-method.read',
      resource: '4',
    });
    expect(target('sales-orders/4', 'PATCH')).toEqual({
      operation: 'orders.shipping-method.write',
      resource: '4',
      write: true,
    });
    expect(target('delivery-notes/1/line-items?pageNumber=2')).toMatchObject({
      operation: 'fulfillment.read',
      resource: '1',
    });
    expect(target('warehouses/1/items/5/stocks')).toMatchObject({
      operation: 'items.read',
      resource: '5',
    });
    expect(target('items/1/suppliers')).toMatchObject({
      operation: 'items.read',
      resource: '1',
    });
    expect(target('suppliers/2')).toMatchObject({
      operation: 'suppliers.read',
      resource: '2',
    });
    expect(target('purchase-orders', 'POST')).toEqual({
      operation: 'purchase-orders.submit',
      resource: undefined,
      write: true,
    });
    expect(target('purchase-orders/4')).toMatchObject({
      operation: 'purchase-orders.read',
      resource: '4',
    });
    expect(target('unknown')).toMatchObject({ operation: 'unknown' });
  });

  it('rejects missing credentials and app registration headers', async () => {
    const { context } = createFixture();
    const unauthorized = jtl.unauthorized(request('items'));
    expect(unauthorized).toMatchObject({
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
      body: { status: 401, title: 'Unauthorized' },
    });
    for (const headers of [
      { authorization: '' },
      { authorization: 'Basic abc' },
      { 'x-appid': '' },
    ])
      expect(await call(context, 'items', 'GET', undefined, headers)).toEqual(
        unauthorized,
      );
    expect(
      (
        await call(context, 'items', 'GET', undefined, {
          authorization: 'Bearer cloud',
          'x-tenant-id': '6a1c1d2e-0d3c-4a43-9b6e-6f4d3c2b1a00',
        })
      ).status,
    ).toBe(200);
    expect((await call(context, 'unknown')).status).toBe(404);
  });

  it('limits clients to 60 requests restored at 20 per second', () => {
    const limit = jtl.rateLimit!;
    const bucket: Bucket = { available: limit.capacity, at: 0 };
    const accepted = Array.from({ length: 61 }, () =>
      charge(limit, bucket, limit.cost(request('items')), 0),
    );
    expect(accepted.filter(Boolean)).toHaveLength(60);
    expect(charge(limit, bucket, 1, 50)).toBe(true);
    expect(limit.reject(1, 0)).toMatchObject({
      status: 429,
      headers: {
        'content-type': 'application/problem+json',
        'retry-after': '1',
      },
      body: { status: 429, title: 'Too Many Requests' },
    });
    expect(limit.reject(50, 0).headers['retry-after']).toBe('3');
  });

  it('drifts successful responses to an incompatible field casing', async () => {
    const { context } = await seeded();
    await order(context);
    const page = jtl.drift(await call(context, 'sales-orders'));
    expect(page.body).toMatchObject({ TotalItems: 1, Items: [{ id: 1 }] });
    expect(page.body).not.toHaveProperty('items');
    expect(
      jtl.drift(await call(context, 'sales-orders/1/line-items')).body,
    ).toMatchObject({ Items: [{ Id: 1, SalesOrderId: 1 }] });
    expect(
      jtl.drift(await call(context, 'warehouses/1/items/1/stocks')).body,
    ).toMatchObject({ TotalQuantity: 100 });
    const missing = await call(context, 'sales-orders/9');
    expect(jtl.drift(missing)).toBe(missing);
  });
});
