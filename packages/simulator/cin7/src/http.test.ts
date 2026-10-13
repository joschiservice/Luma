import { createMemoryStore } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import {
  allocation,
  type Cin7Context,
  createCin7Simulator,
  type ErpItem,
  type ErpOrder,
  guid,
  recordOf,
} from './index.js';

const kinds = {
  item: 'item',
  customer: 'customer',
  supplier: 'supplier',
  order: 'sales-order',
  note: 'delivery-note',
  purchaseOrder: 'purchase-order',
};

// Records are written directly; the account only serves them.
const cin7 = createCin7Simulator({ kinds, command: async () => undefined });

const accountId = 'c1700000-0000-4000-8000-000000000001';

function createContext(): Cin7Context {
  return {
    store: createMemoryStore(),
    now: Date.parse('2026-10-01T08:00:00Z'),
    wallTime: Date.parse('2026-10-01T08:00:00Z'),
    instance: 'cin7',
    config: {
      accountId,
      company: 'Luma Goods GmbH',
      baseCurrency: 'EUR',
      warehouses: [
        { id: '1', name: 'Hamburg' },
        { id: '2', name: 'Leipzig' },
      ],
      shippingMethods: [{ id: '7', name: 'Standard' }],
    },
    indexLagMs: 0,
    notify: () => {},
  };
}

async function seeded(items = 3) {
  const context = createContext();
  for (let index = 1; index <= items; index++)
    await context.store.put<ErpItem>(kinds.item, String(index), {
      id: String(index),
      sku: `SKU-${index}`,
      name: `Item ${index}`,
      price: 10,
      gtin: null,
      manufacturer: 'Luma',
      active: true,
      stock: { '1': 10, '2': 5 },
      reserved: 0,
      modified: '2026-10-01T08:00:00.000Z',
    });

  return context;
}

const get = (
  context: Cin7Context,
  path: string,
  headers: Record<string, string> = {
    'api-auth-accountid': accountId,
    'api-auth-applicationkey': 'key',
  },
) =>
  cin7.handle(context, {
    url: `https://inventory.dearsystems.com/ExternalApi/v2/${path}`,
    method: 'GET',
    headers,
    body: null,
  });

describe('Cin7 Core API', () => {
  it('rejects another account or a missing key with 403', async () => {
    const context = createContext();
    expect((await get(context, 'me', {})).status).toBe(403);
    expect(
      (
        await get(context, 'me', {
          'api-auth-accountid': guid('sale', '1'),
          'api-auth-applicationkey': 'key',
        })
      ).status,
    ).toBe(403);
    expect((await get(context, 'Me')).body).toEqual({
      Company: 'Luma Goods GmbH',
      Currency: 'EUR',
    });
  });

  it('reports foreign-currency sales against the base currency with tax', async () => {
    const context = await seeded(1);
    context.config.baseCurrency = 'AUD';
    context.config.currencyRates = { NZD: 0.91 };
    await context.store.put<ErpOrder>(kinds.order, '1', {
      id: '1',
      externalNumber: 'NZ1001',
      cancelled: false,
      paid: true,
      shippingMethodId: '7',
      currency: 'NZD',
      taxRate: 15,
      total: 23,
      date: '2026-10-01T08:00:00.000Z',
      lines: [
        {
          id: '1',
          itemId: '1',
          sku: 'SKU-1',
          name: 'Item 1',
          quantity: 2,
          shipped: 0,
          price: 11.5,
        },
      ],
    });
    const sale = (await get(context, `sale?ID=${guid('sale', '1')}`))
      .body as Record<string, unknown> & {
      Order: { Lines: Record<string, unknown>[] } & Record<string, unknown>;
    };
    expect(sale).toMatchObject({
      CustomerCurrency: 'NZD',
      BaseCurrency: 'AUD',
      CurrencyRate: 1.098901,
      SourceChannel: 'Shopify',
    });
    expect(sale.Order).toMatchObject({ BeforeTax: 20, Tax: 3, Total: 23 });
    expect(sale.Order.Lines[0]).toMatchObject({ Price: 10, Tax: 3, Total: 20 });
    expect((await get(context, 'me')).body).toEqual({
      Company: 'Luma Goods GmbH',
      Currency: 'AUD',
    });
  });

  it('serves a note still being packed as picked work that has not shipped', async () => {
    const context = await seeded(1);
    await context.store.put<ErpOrder>(kinds.order, '1', {
      id: '1',
      externalNumber: 'DE1001',
      cancelled: false,
      paid: true,
      shippingMethodId: '7',
      currency: 'EUR',
      taxRate: 19,
      total: 20,
      date: '2026-10-01T08:00:00.000Z',
      lines: [
        {
          id: '1',
          itemId: '1',
          sku: 'SKU-1',
          name: 'Item 1',
          quantity: 2,
          shipped: 2,
          price: 10,
        },
      ],
    });
    await context.store.put(
      kinds.note,
      '5',
      {
        id: '5',
        orderId: '1',
        warehouse: '1',
        date: '2026-10-01T08:00:00.000Z',
        packages: [
          {
            id: '6',
            shippingDate: null,
            trackingNumber: 'T',
            trackingUrl: 'https://tracking.example.test/T',
          },
        ],
        lines: [{ id: '7', orderLineId: '1', quantity: 2 }],
      },
      { parent: '1' },
    );
    const sale = (await get(context, `sale?ID=${guid('sale', '1')}`)).body as {
      Fulfilments: Record<string, unknown>[];
    };
    expect(sale.Fulfilments[0]).toMatchObject({
      FulFilmentStatus: 'NOT FULFILLED',
      Pick: { Status: 'AUTHORISED' },
      Pack: { Status: 'DRAFT' },
      Ship: { Status: 'NOT AVAILABLE', Lines: [] },
    });
  });

  it('pages the stock report by row across products', async () => {
    const context = await seeded();
    const page = async (number: number) =>
      (await get(context, `ref/productavailability?Page=${number}&Limit=4`))
        .body as { Total: number; ProductAvailabilityList: { ID: string }[] };
    const rows = [
      ...(await page(1)).ProductAvailabilityList,
      ...(await page(2)).ProductAvailabilityList,
    ];
    expect((await page(1)).Total).toBe(6);
    expect(rows.map((row) => recordOf('product', row.ID))).toEqual([
      '1',
      '1',
      '2',
      '2',
      '3',
      '3',
    ]);
  });

  it('validates paging parameters', async () => {
    const context = createContext();
    expect((await get(context, 'saleList?Limit=1001')).status).toBe(400);
    expect((await get(context, 'saleList?Page=0')).status).toBe(400);
    expect((await get(context, 'unknownEndpoint')).status).toBe(404);
  });

  it('allocates reservations by location order, oversold units at the first', () => {
    expect(allocation({ '1': 3, '2': 5 }, 4, ['1', '2'])).toEqual({
      '1': 3,
      '2': 1,
    });
    expect(allocation({ '1': 1 }, 3, ['1', '2'])).toEqual({ '1': 3, '2': 0 });
  });

  it('renames list keys under schema drift', () => {
    const drifted = cin7.drift({
      status: 200,
      headers: {},
      body: { Total: 0, Page: 1, SaleList: [] },
    });
    expect(drifted.body).toEqual({ Total: 0, Page: 1, SaleListItems: [] });
  });
});
