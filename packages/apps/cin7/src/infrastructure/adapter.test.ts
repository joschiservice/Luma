import type { CapabilityInput, ReadCapability } from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import { createRequestPacer } from '@luma/connector-cin7';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import { type Cin7ConnectorOptions, createCin7Connector } from './adapter.js';

vi.mock('@luma/identity', () => ({
  requireTenant(context: TenantContext, tenantId: string) {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));

const context = { tenantId: 'tenant-a', requestId: 'r' } as TenantContext;

const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });

const [bread, milk, kit] = [id(101), id(102), id(103)];
const [main, back] = [id(201), id(202)];

function saleOf(n: number, overrides: Record<string, unknown> = {}) {
  return {
    ID: id(n),
    CustomerID: id(301),
    CustomerReference: '#1001',
    SourceChannel: 'Shopify',
    CustomerCurrency: 'EUR',
    SaleOrderDate: '2026-10-01T00:00:00',
    ShipBy: '2026-10-03T00:00:00',
    LastModifiedOn: '2026-10-02T08:30:00.25Z',
    Status: 'ORDERED',
    CombinedPaymentStatus: 'PAID',
    FulFilmentStatus: 'NOT FULFILLED',
    Order: {
      SaleOrderNumber: `SO-${n}`,
      Status: 'AUTHORISED',
      Total: 31.5,
      Lines: [
        { ProductID: bread, SKU: 'BREAD', Name: 'Bread', Quantity: 2 },
        { ProductID: bread, SKU: 'BREAD', Name: 'Bread', Quantity: '1.5000' },
        { ProductID: milk, SKU: 'MILK', Name: 'Milk', Quantity: 1 },
      ],
    },
    Fulfilments: [],
    CreditNotes: [],
    ...overrides,
  };
}

function fixture() {
  const sales = [
    saleOf(1, {
      Fulfilments: [
        {
          TaskID: id(401),
          FulFilmentStatus: 'FULFILLED',
          Pick: {
            Status: 'AUTHORISED',
            Lines: [
              {
                ProductID: bread,
                Quantity: 3.5,
                LocationID: main,
                Location: 'Main',
              },
            ],
          },
          Pack: { Status: 'AUTHORISED', Lines: [] },
          Ship: {
            Status: 'AUTHORISED',
            RequireBy: null,
            Lines: [
              {
                ShipmentDate: '2026-10-02T00:00:00',
                Carrier: 'DHL',
                TrackingNumber: 'T-1',
                TrackingURL: 'https://track.example/T-1',
                IsShipped: true,
              },
            ],
          },
        },
        {
          TaskID: id(402),
          FulFilmentStatus: 'NOT FULFILLED',
          Pick: {
            Status: 'DRAFT',
            Lines: [{ ProductID: milk, Quantity: 1, LocationID: main }],
          },
          Pack: { Status: 'NOT AVAILABLE', Lines: [] },
          Ship: { Status: 'NOT AVAILABLE', Lines: [] },
        },
      ],
      CreditNotes: [
        {
          TaskID: id(501),
          Status: 'AUTHORISED',
          CreditNoteDate: '2026-10-04T00:00:00',
          Total: 10,
          Lines: [
            { ProductID: bread, Quantity: 1 },
            { ProductID: kit, Quantity: 1 },
          ],
          Refunds: [{ Amount: 10, DatePaid: '2026-10-05T00:00:00' }],
          Restock: [{ ProductID: bread, Quantity: 1 }],
        },
        {
          TaskID: id(502),
          Status: 'VOIDED',
          Lines: [{ ProductID: milk, Quantity: 1 }],
          Refunds: [],
          Restock: [],
        },
        {
          TaskID: id(503),
          Status: 'DRAFT',
          Lines: [{ ProductID: milk, Quantity: 1 }],
          Refunds: [],
          Restock: [],
        },
      ],
    }),
    saleOf(2, {
      Status: 'VOIDED',
      Order: { ...saleOf(2).Order, Status: 'VOIDED' },
    }),
    saleOf(3, {
      Status: 'ESTIMATED',
      Order: { Status: 'NOT AVAILABLE', Lines: [] },
    }),
  ];
  const listRow = (sale: (typeof sales)[number]) => ({
    SaleID: sale.ID,
    OrderNumber: `SO-${sale.ID.slice(-1)}`,
    Status: sale.Status,
    OrderStatus: sale.Order.Status,
    FulFilmentStatus: sale.FulFilmentStatus,
    Updated: sale.LastModifiedOn,
  });
  const products = [
    {
      ID: bread,
      SKU: 'BREAD',
      Name: 'Bread',
      Status: 'Active',
      UOM: 'Item',
      PriceTier1: '2.5000',
    },
    {
      ID: milk,
      SKU: 'MILK',
      Name: 'Milk',
      Status: 'Deprecated',
      UOM: 'Litre',
      PriceTier1: 0,
    },
    { ID: kit, SKU: 'KIT', Name: 'Kit', Status: 'Setup required', UOM: 'Box' },
  ];
  const stock = [
    { ID: bread, Location: 'Main', OnHand: 5, Allocated: 1, Available: 4 },
    {
      ID: bread,
      Location: 'Main',
      OnHand: '2.5',
      Allocated: 0,
      Available: '2.5',
    },
    { ID: bread, Location: 'Back', OnHand: 1, Allocated: 0, Available: 1 },
    { ID: milk, Location: 'Main', OnHand: 3, Allocated: null, Available: 3 },
  ];
  const locations = [
    { ID: main, Name: 'Main' },
    { ID: back, Name: 'Back' },
  ];
  const purchases = [
    {
      ID: id(601),
      SupplierID: id(701),
      OrderNumber: 'PO-1',
      OrderDate: '2026-09-30T00:00:00',
      RequiredBy: '2026-10-10T00:00:00',
      Status: 'RECEIVING',
      CombinedReceivingStatus: 'PARTIALLY RECEIVED',
      LastUpdatedDate: '2026-10-01T00:00:00',
      Order: {
        Status: 'AUTHORISED',
        Lines: [
          { ProductID: bread, SKU: 'BREAD', Quantity: 10 },
          { ProductID: milk, SKU: 'MILK', Quantity: 4 },
        ],
      },
      StockReceived: [
        {
          Status: 'AUTHORISED',
          Lines: [
            { ProductID: bread, Quantity: 4, Received: true },
            { ProductID: bread, Quantity: 2, Received: false },
          ],
        },
        {
          Status: 'DRAFT',
          Lines: [{ ProductID: milk, Quantity: 4, Received: true }],
        },
      ],
    },
  ];
  const requests: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/ExternalApi/v2/', '');
    requests.push(`${path}${url.search}`);
    const q = (key: string) => url.searchParams.get(key);
    const page = (key: string, rows: unknown[]) => {
      const number = Number(q('Page') ?? 1);
      const limit = Number(q('Limit') ?? 100);

      return Response.json({
        Total: rows.length,
        Page: number,
        [key]: rows.slice((number - 1) * limit, number * limit),
      });
    };
    if (path === 'saleList') return page('SaleList', sales.map(listRow));
    if (path === 'saleCreditNoteList')
      return page(
        'SaleList',
        sales.filter((s) => s.CreditNotes.length).map(listRow),
      );
    if (path === 'sale') {
      const found = sales.find((sale) => sale.ID === q('ID'));

      return found ? Response.json(found) : new Response('', { status: 404 });
    }
    if (path === 'product') return page('Products', products);
    if (path === 'ref/location')
      return page('LocationList', q('Deprecated') ? [] : locations);
    if (path === 'ref/productavailability')
      return page(
        'ProductAvailabilityList',
        stock.filter(
          (row) =>
            (!q('ID') || row.ID === q('ID')) &&
            (!q('Location') || row.Location === q('Location')),
        ),
      );
    if (path === 'customer')
      return page('CustomerList', [
        {
          ID: id(301),
          Name: 'Hamilton Smith Pty',
          DisplayName: '',
          Status: 'Active',
          Tags: 'vip, wholesale,vip',
          LastModifiedOn: '2026-09-01T00:00:00Z',
          Addresses: [
            {
              Line1: 'Billing St 1',
              City: 'Berlin',
              Country: 'Germany',
              Type: 'Billing',
            },
            {
              Line1: 'Ship St 2',
              City: 'Hamburg',
              Country: 'Germany',
              Type: 'Shipping',
              DefaultForType: true,
            },
          ],
          Contacts: [
            {
              Name: 'A',
              Email: 'a@example.test',
              Phone: '',
              MobilePhone: '+49 1',
            },
          ],
        },
      ]);
    if (path === 'supplier')
      return page('SupplierList', [
        {
          ID: id(701),
          Name: 'Bakery Supplies',
          Status: 'Active',
          Contacts: [{ Email: 'orders@bakery.test', Default: true }],
        },
      ]);
    if (path === 'purchaseList')
      return page(
        'PurchaseList',
        purchases.map((p) => ({
          ID: p.ID,
          LastUpdatedDate: p.LastUpdatedDate,
        })),
      );
    if (path === 'advanced-purchase')
      return Response.json(purchases.find((p) => p.ID === q('ID')));

    return new Response('', { status: 404 });
  });
  const recorded: unknown[] = [];
  let next = 0;
  const options: Cin7ConnectorOptions = {
    tenantId: 'tenant-a',
    connectionId: 'connection-a',
    connection: {
      accountId: id(1),
      applicationKey: async () => 'key',
    },
    fetch,
    pacer: createRequestPacer({ intervalMs: 0 }),
    customers: true,
    recordObservations: async (evidence) => {
      recorded.push(evidence);
    },
    now: () => new Date('2026-10-06T12:00:00Z'),
    id: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
  };
  const connector = createCin7Connector(options);
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });

  async function read<K extends ReadCapability>(
    capability: K,
    input: CapabilityInput<K>,
  ) {
    const result = await runtime.read(context, {
      connectionId: 'connection-a',
      capability,
      version: '0',
      input,
    });
    if (!result.ok) throw new Error(result.error.code);

    return result.value;
  }

  return { read, requests, recorded, sales, stock, fetch };
}

describe('Cin7 orders', () => {
  it('imports authorised and voided orders with lines summed per product', async () => {
    const { read, requests } = fixture();
    const page = await read('orders.read', { limit: 100 });
    expect(page.items.map((item) => item.source.externalId)).toEqual([
      id(1),
      id(2),
    ]);
    expect(page.items[0]).toMatchObject({
      sourceUpdatedAt: '2026-10-02T08:30:00.250Z',
      data: {
        displayNumber: 'SO-1',
        externalOrderNumber: '#1001',
        placedAt: '2026-10-01T00:00:00.000Z',
        dueAt: '2026-10-03T00:00:00.000Z',
        total: { amount: '31.5', currency: 'EUR' },
        customer: ref(id(301)),
        status: 'open',
        paymentStatus: 'paid',
        lines: [
          {
            id: ref(bread, id(1)),
            sku: ref(bread),
            quantity: { amount: '3.5', unit: 'each' },
            cancelledQuantity: null,
            skuCode: 'BREAD',
            title: 'Bread',
          },
          {
            id: ref(milk, id(1)),
            sku: ref(milk),
            quantity: { amount: '1', unit: 'Litre' },
          },
        ],
      },
    });
    expect(page.items[1]!.data.status).toBe('cancelled');
    // The quote needs no detail read.
    expect(requests.filter((r) => r.startsWith('sale?'))).toHaveLength(2);
  });

  it('sends update filters as zone-less UTC times', async () => {
    const { read, requests } = fixture();
    await read('orders.read', {
      limit: 100,
      updatedSince: '2026-10-01T12:00:00+02:00',
    });
    expect(requests[0]).toBe(
      'saleList?Page=1&Limit=25&UpdatedSince=2026-10-01T10%3A00%3A00.000',
    );
  });

  it('rejects a cursor from another query', async () => {
    const { read } = fixture();
    const first = await read('products.read', { limit: 1 });
    await expect(
      read('products.read', {
        limit: 2,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('invalid_input');
  });
});

describe('Cin7 fulfillments and refunds', () => {
  it('reports each fulfilment with its pick lines and shipments', async () => {
    const { read } = fixture();
    const page = await read('fulfillment.read', { limit: 100 });
    expect(page.items.map((item) => item.data)).toEqual([
      {
        order: ref(id(1)),
        status: 'shipped',
        lines: [
          {
            orderLine: ref(bread, id(1)),
            quantity: { amount: '3.5', unit: 'each' },
          },
        ],
        lastProgressAt: '2026-10-02T00:00:00.000Z',
        progressBasis: 'source_updated',
        failureCode: null,
        location: { id: ref(main), name: 'Main' },
        fulfillBy: '2026-10-03T00:00:00.000Z',
        tracking: [
          {
            carrier: 'DHL',
            number: 'T-1',
            url: 'https://track.example/T-1',
          },
        ],
      },
      expect.objectContaining({
        status: 'processing',
        lastProgressAt: '2026-10-02T08:30:00.250Z',
        location: { id: ref(main), name: null },
      }),
    ]);
  });

  it('rejects a fulfilment line for a product the order lacks', async () => {
    const { read, sales } = fixture();
    const [, pending] = sales[0]!.Fulfilments as {
      Pick: { Lines: { ProductID: string }[] };
    }[];
    pending!.Pick.Lines[0]!.ProductID = kit;
    await expect(read('fulfillment.read', { limit: 100 })).rejects.toThrow(
      'invalid_response',
    );
  });

  it('reports authorised credit notes and removes voided ones', async () => {
    const { read } = fixture();
    const page = await read('returns.read', { limit: 100 });
    expect(
      page.items.map((item) => [item.source.externalId, item.kind]),
    ).toEqual([
      [id(501), 'snapshot'],
      [id(502), 'tombstone'],
    ]);
    expect(page.items[0]!.data).toEqual({
      type: 'refund',
      order: ref(id(1)),
      return: null,
      createdAt: '2026-10-04T00:00:00.000Z',
      total: { amount: '10', currency: 'EUR' },
      // The kit is not on the order, so it is no refund line.
      lines: [
        {
          orderLine: ref(bread, id(1)),
          quantity: { amount: '1', unit: 'each' },
          restock: 'return',
          restocked: true,
        },
      ],
      transactions: [
        {
          status: 'success',
          amount: { amount: '10', currency: 'EUR' },
          processedAt: '2026-10-05T00:00:00.000Z',
          gateway: null,
        },
      ],
    });
  });

  it('reuses unchanged sale details across streams', async () => {
    const { read, requests } = fixture();
    await read('orders.read', { limit: 100 });
    await read('fulfillment.read', { limit: 100 });
    await read('returns.read', { limit: 100 });
    expect(requests.filter((r) => r.startsWith('sale?'))).toHaveLength(2);
  });
});

describe('Cin7 catalog and stock', () => {
  it('maps products and their units', async () => {
    const { read } = fixture();
    const page = await read('products.read', { limit: 100 });
    expect(page.items.map((item) => item.data)).toEqual([
      {
        title: 'Bread',
        status: 'active',
        vendor: null,
        skus: [
          {
            id: ref(bread),
            code: 'BREAD',
            unit: 'each',
            title: null,
            price: { amount: '2.5', currency: null },
            barcode: null,
          },
        ],
      },
      expect.objectContaining({
        status: 'archived',
        skus: [expect.objectContaining({ unit: 'Litre', price: null })],
      }),
      expect.objectContaining({ status: 'draft' }),
    ]);
  });

  it('sums bins and batches per product and location', async () => {
    const { read } = fixture();
    const page = await read('inventory.read', { limit: 100 });
    expect(
      page.items.map((item) => [
        item.source.externalId,
        item.source.scopeKey,
        item.data,
      ]),
    ).toEqual([
      [
        bread,
        main,
        {
          sku: ref(bread),
          location: ref(main),
          unit: 'each',
          onHand: '7.5',
          reserved: '1',
          available: '6.5',
          availabilityBasis: 'provider_reported',
        },
      ],
      [bread, back, expect.objectContaining({ onHand: '1' })],
      [
        milk,
        main,
        expect.objectContaining({
          unit: 'Litre',
          reserved: null,
          available: '3',
        }),
      ],
    ]);
  });

  it('rereads products at page edges in full', async () => {
    const { read, stock, requests } = fixture();
    // Pad the report so the first page ends inside milk's rows.
    stock.splice(
      0,
      0,
      ...Array.from({ length: 998 }, (_, index) => ({
        ID: id(1000 + index),
        Location: 'Main',
        OnHand: 1,
        Allocated: 0,
        Available: 1,
      })),
    );
    stock.push({
      ID: milk,
      Location: 'Back',
      OnHand: 2,
      Allocated: 0,
      Available: 2,
    });
    const first = await read('inventory.read', { limit: 100 });
    expect(first.nextCursor).not.toBeNull();
    expect(requests).toContain(
      `ref/productavailability?ID=${bread}&Page=1&Limit=1000`,
    );
    const second = await read('inventory.read', {
      limit: 100,
      cursor: first.nextCursor!,
    });
    const breadMain = [...first.items, ...second.items].filter(
      (item) =>
        item.source.externalId === bread && item.source.scopeKey === main,
    );
    expect(breadMain.map((item) => item.data.onHand)).toEqual(['7.5']);
    expect(
      [...first.items, ...second.items]
        .filter((item) => item.source.externalId === milk)
        .map((item) => [item.source.scopeKey, item.data.onHand]),
    ).toEqual([
      [main, '3'],
      [back, '2'],
    ]);
  });

  it('rejects stock at a location it cannot identify', async () => {
    const { read, stock } = fixture();
    stock[0]!.Location = 'Unknown';
    await expect(read('inventory.read', { limit: 100 })).rejects.toThrow(
      'invalid_response',
    );
  });
});

describe('Cin7 customers and purchasing', () => {
  it('maps the default contact and shipping address', async () => {
    const { read } = fixture();
    const page = await read('customers.read', { limit: 100 });
    expect(page.items[0]!.data).toEqual({
      displayName: 'Hamilton Smith Pty',
      email: 'a@example.test',
      phone: '+49 1',
      address: {
        line1: 'Ship St 2',
        line2: null,
        city: 'Hamburg',
        region: null,
        postalCode: null,
        country: 'Germany',
      },
      state: 'enabled',
      createdAt: null,
      orderCount: null,
      amountSpent: null,
      tags: ['vip', 'wholesale'],
      shared: { contact: true, address: true },
    });
  });

  it('counts only authorised receipts as delivered', async () => {
    const { read } = fixture();
    const suppliers = await read('suppliers.read', { limit: 100 });
    expect(suppliers.items[0]!.data).toEqual({
      name: 'Bakery Supplies',
      number: null,
      active: true,
      email: 'orders@bakery.test',
    });
    const page = await read('purchase-orders.read', { limit: 25 });
    expect(page.items[0]!.data).toMatchObject({
      supplier: ref(id(701)),
      orderNumber: 'PO-1',
      status: 'partially_delivered',
      requestedDeliveryDate: '2026-10-10',
      lines: [
        {
          id: ref(bread, id(601)),
          quantity: { amount: '10', unit: 'each' },
          deliveredQuantity: '4',
        },
        { id: ref(milk, id(601)), deliveredQuantity: '0' },
      ],
    });
  });
});
