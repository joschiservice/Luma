import { readFileSync } from 'node:fs';

import { buildSchema, parse as gql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { recordKinds } from '../domain/records.js';
import { createShopifyRecordReader } from './records.js';

const gid = (kind: string) => `gid://shopify/${kind}/1`;
const updatedAt = '2026-09-28T00:00:00Z';
const money = { amount: '12.34', currencyCode: 'EUR' };
const bag = { shopMoney: money };
const order = {
  id: gid('Order'),
  updatedAt,
  createdAt: updatedAt,
  name: '#1001',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'ON_HOLD',
  currentTotalPriceSet: bag,
  totalOutstandingSet: bag,
};
const customer = {
  id: gid('Customer'),
  updatedAt,
  numberOfOrders: '3',
  amountSpent: money,
  email: 'must-not-leak@example.com',
};
const refund = {
  id: gid('Refund'),
  createdAt: updatedAt,
  updatedAt,
  totalRefundedSet: bag,
  order: { id: gid('Order') },
};
const returned = {
  id: gid('Return'),
  name: '#R1',
  status: 'OPEN',
  order: { id: gid('Order') },
};
const work = {
  id: gid('FulfillmentOrder'),
  updatedAt,
  status: 'ON_HOLD',
  requestStatus: 'UNSUBMITTED',
  order: { id: gid('Order') },
  assignedLocation: { location: { id: gid('Location') } },
  fulfillmentHolds: [
    { id: gid('FulfillmentHold'), reason: 'INVENTORY_OUT_OF_STOCK' },
  ],
};
const variant = {
  id: gid('ProductVariant'),
  title: 'Blue',
  sku: 'BLUE',
  price: '12.34',
  updatedAt,
  product: { id: gid('Product') },
  inventoryItem: { id: gid('InventoryItem') },
};
const scopes = [
  'read_orders',
  'read_customers',
  'read_returns',
  'read_products',
  'read_inventory',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_assigned_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'read_all_orders',
];
const page = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor },
});

function fixture(granted = scopes, approved = true) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('LumaRecordAccess'))
      return Response.json({
        data: {
          currentAppInstallation: {
            accessScopes: granted.map((handle) => ({ handle })),
          },
        },
      });
    if (query.includes('LumaRecordList'))
      return Response.json({
        data: {
          records: page([
            query.includes('orders(')
              ? order
              : { id: gid('Product'), title: 'Mug', updatedAt },
          ]),
        },
      });
    let value: unknown;
    if (query.includes('children:')) {
      const nodes = query.includes('children: orders')
        ? [order]
        : query.includes('children: lineItems')
          ? [
              {
                id: gid('LineItem'),
                name: 'Blue',
                quantity: 2,
                variant: { id: variant.id },
              },
            ]
          : query.includes('children: fulfillmentOrders')
            ? [work]
            : query.includes('children: returns')
              ? [returned]
              : query.includes('children: events')
                ? [
                    {
                      id: gid('BasicEvent'),
                      createdAt: updatedAt,
                      action: 'confirmed',
                      message: 'private',
                    },
                  ]
                : query.includes('children: variants')
                  ? [variant]
                  : query.includes('children: inventoryLevels')
                    ? [
                        {
                          id: gid('InventoryLevel'),
                          updatedAt,
                          location: {
                            id: gid('Location'),
                            name: 'Tokyo',
                            isActive: true,
                          },
                          quantities: [{ name: 'available', quantity: -2 }],
                        },
                      ]
                    : [
                        {
                          id: gid('ReturnLineItem'),
                          quantity: 1,
                          returnReason: 'DEFECTIVE',
                          fulfillmentLineItem: {
                            lineItem: { id: gid('LineItem') },
                          },
                        },
                      ];
      value = { children: page(nodes) };
    } else if (query.includes('transactions {'))
      value = {
        transactions: [
          {
            id: gid('OrderTransaction'),
            createdAt: updatedAt,
            processedAt: updatedAt,
            kind: 'SALE',
            status: 'SUCCESS',
            gateway: 'shopify_payments',
            amountSet: bag,
            parentTransaction: null,
          },
        ],
      };
    else if (query.includes('customer {')) value = { customer };
    else if (query.includes('refunds {')) value = { refunds: [refund] };
    else
      value = {
        Order: order,
        Customer: customer,
        Product: {
          id: gid('Product'),
          title: 'Mug',
          status: 'ACTIVE',
          updatedAt,
        },
        ProductVariant: variant,
        InventoryItem: {
          id: gid('InventoryItem'),
          tracked: true,
          sku: 'BLUE',
          updatedAt,
          variant: { id: variant.id },
        },
        FulfillmentOrder: work,
        Return: returned,
        Refund: refund,
      }[variables.id.split('/')[3] as 'Order'];

    return Response.json({ data: { node: value } });
  });
  const token = vi.fn(async () => 'private-token');

  return {
    fetch,
    token,
    read: createShopifyRecordReader({
      shop: 'example.myshopify.com',
      tenantId: 'tenant-a',
      connectionId: 'connection-a',
      accessToken: token,
      fetch,
      protectedCustomerDataApproved: approved,
      now: () => new Date(updatedAt),
    }),
  };
}

describe('Shopify operational records', () => {
  it('maps linked records, decimal amounts, holds, real events and provenance with allowlisted data', async () => {
    const f = fixture();
    const detail = await f.read('Order', gid('Order'));
    expect(detail).toMatchObject({
      tenantId: 'tenant-a',
      connectionId: 'connection-a',
      observedAt: new Date(updatedAt).toISOString(),
      apiVersion: '2026-07',
    });
    expect(
      detail.sections.find((v) => v.key === 'transactions')?.rows[0],
    ).toMatchObject({
      id: gid('OrderTransaction'),
      fields: { Amount: '12.34 EUR', Status: 'SUCCESS' },
      sourceUpdatedAt: null,
    });
    expect(
      detail.sections.find((v) => v.key === 'fulfillment')?.rows[0]?.fields
        .Holds,
    ).toContain('INVENTORY_OUT_OF_STOCK');
    expect(
      detail.sections.find((v) => v.key === 'events')?.rows[0],
    ).toMatchObject({
      id: gid('BasicEvent'),
      fields: { Occurred: updatedAt, Action: 'confirmed' },
    });
    expect(
      detail.sections.find((v) => v.key === 'returns')?.rows[0]?.links,
    ).toContainEqual({ kind: 'Order', id: gid('Order'), label: 'Order' });
    expect(JSON.stringify(detail)).not.toMatch(
      /must-not-leak|private-token|private/,
    );
    expect(f.token).toHaveBeenCalledTimes(f.fetch.mock.calls.length);
  });
  it('never queries missing scopes or unapproved customer data and reports limited fulfillment and history', async () => {
    const f = fixture(
      [
        'read_orders',
        'read_customers',
        'read_merchant_managed_fulfillment_orders',
      ],
      false,
    );
    const detail = await f.read('Order', gid('Order'));
    expect(detail.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'customer',
          status: 'approval_required',
          rows: [],
        }),
        expect.objectContaining({
          key: 'returns',
          status: 'missing_scope',
          rows: [],
        }),
        expect.objectContaining({ key: 'fulfillment', status: 'partial' }),
        expect.objectContaining({ key: 'history', status: 'partial' }),
      ]),
    );
    const queries = f.fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)).query)
      .join('\n');
    expect(queries).not.toMatch(/customer \{|children: returns/);
    const missing = await fixture(['read_orders']).read(
      'Customer',
      gid('Customer'),
    );
    expect(missing.sections[0]?.status).toBe('missing_scope');
  });
  it('isolates denied sections but rejects transport and malformed responses', async () => {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, init) =>
      String(init?.body).includes('customer {')
        ? Promise.resolve(
            Response.json({
              data: { node: { customer } },
              errors: [
                { extensions: { code: 'ACCESS_DENIED' }, message: 'private' },
              ],
            }),
          )
        : fallback(url, init),
    );
    const detail = await f.read('Order', gid('Order'));
    expect(detail.sections.find((v) => v.key === 'customer')).toMatchObject({
      status: 'access_denied',
      rows: [],
    });
    expect(detail.sections.find((v) => v.key === 'refunds')?.rows).toHaveLength(
      1,
    );
    f.fetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(f.read('Order', gid('Order'))).rejects.toThrow('transient');
  });
  it('drains nested pages and rejects repeated cursors and mismatched IDs', async () => {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes('children: variants'))
        return Promise.resolve(
          Response.json({
            data: {
              node: {
                children: variables.after
                  ? page([{ ...variant, id: 'gid://shopify/ProductVariant/2' }])
                  : page([variant], 'second'),
              },
            },
          }),
        );

      return fallback(url, init);
    });
    expect(
      (await f.read('Product', gid('Product'))).sections[1]?.rows,
    ).toHaveLength(2);
    f.fetch.mockImplementation((url, init) =>
      String(init?.body).includes('children: variants')
        ? Promise.resolve(
            Response.json({
              data: { node: { children: page([variant], 'repeat') } },
            }),
          )
        : fallback(url, init),
    );
    await expect(f.read('Product', gid('Product'))).rejects.toThrow(
      'invalid_response',
    );
    await expect(f.read('Product', gid('Order'))).rejects.toThrow(
      'invalid_input',
    );
  });
  it('validates every emitted query against Shopify 2026-07', async () => {
    const schema = buildSchema(
      readFileSync(
        new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
        'utf8',
      ),
    );
    const f = fixture();
    for (const kind of recordKinds) await f.read(kind, gid(kind));
    await f.read('Order');
    await f.read('Product');
    for (const [, init] of f.fetch.mock.calls) {
      const { query } = JSON.parse(String(init?.body));
      expect(
        validate(schema, gql(query)).map((v) => v.message),
        query,
      ).toEqual([]);
    }
  });
});
