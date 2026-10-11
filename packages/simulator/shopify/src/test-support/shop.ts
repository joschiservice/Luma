import {
  createMemoryStore,
  type ProviderEvent,
  type ProviderRequest,
} from '@luma/simulator-core';

import { shopify } from '../index.js';
import type { ShopifyContext } from '../records.js';
import type {
  ShopifyCommand,
  ShopifyConfig,
  ShopifySeedProduct,
} from '../types.js';

const config: ShopifyConfig = {
  shop: 'luma-test.myshopify.com',
  name: 'Luma Test',
  currency: 'EUR',
  orderPrefix: 'T',
  locations: [
    { id: '1', name: 'Hamburg Hub' },
    { id: '2', name: 'Vienna Depot' },
  ],
  scopes: [
    'read_orders',
    'read_all_orders',
    'read_products',
    'read_inventory',
    'write_inventory',
    'read_customers',
    'read_returns',
    'write_orders',
    'read_locations',
    'read_merchant_managed_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
};

export const catalog: ShopifySeedProduct[] = [
  {
    id: '10',
    title: 'Canvas tote',
    vendor: 'Luma Goods',
    productType: 'Bags',
    published: true,
    variants: [
      {
        id: '11',
        sku: 'TOTE-NAT',
        title: 'Natural',
        price: '24.00',
        barcode: '4006381333931',
        stock: { '1': 100, '2': 5 },
      },
      {
        id: '12',
        sku: 'TOTE-BLK',
        title: 'Black',
        price: '26.50',
        barcode: null,
        stock: { '1': 40 },
      },
    ],
  },
  {
    id: '20',
    title: 'Linen shirt',
    vendor: 'Nordwind',
    productType: 'Shirts',
    published: false,
    variants: [
      {
        id: '21',
        sku: 'SHIRT-M',
        title: 'Default Title',
        price: '59.90',
        barcode: null,
        stock: { '1': 10, '2': 10 },
      },
    ],
  },
];

/** Builds a Shopify Admin GraphQL request with an access token. */
export function graphqlRequest(
  query: string,
  variables: Record<string, unknown> = {},
  token: string | null = 'synthetic',
): ProviderRequest {
  return {
    url: `https://${config.shop}/admin/api/2026-07/graphql.json`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-shopify-access-token': token } : {}),
    },
    body: JSON.stringify({ query, variables }),
  };
}

/** A shop with a memory store, a controllable clock and recorded notifications. */
export function createShop(
  options: { indexLagMs?: number; scopes?: string[] } = {},
) {
  const store = createMemoryStore();
  const events: ProviderEvent[] = [];
  const shop = {
    store,
    events,
    now: Date.parse('2026-09-01T08:00:00Z'),
    context(): ShopifyContext {
      return {
        store,
        now: shop.now,
        wallTime: shop.now,
        instance: 'shop',
        config: options.scopes ? { ...config, scopes: options.scopes } : config,
        indexLagMs: options.indexLagMs ?? 0,
        notify: (event) => events.push(event),
      };
    },
    advance(ms: number) {
      shop.now += ms;
    },
    run(value: ShopifyCommand) {
      return shopify.command(shop.context(), value);
    },
    /** Sends a query and returns the response body's data and errors. */
    async query(query: string, variables: Record<string, unknown> = {}) {
      const response = await shopify.handle(
        shop.context(),
        graphqlRequest(query, variables),
      );

      return response.body as {
        data?: Record<string, unknown>;
        errors?: { message: string; extensions?: { code?: string } }[];
      };
    },
    /** Seeds the catalog and an order of two totes and a black tote at location 1. */
    async order(
      extra: Partial<Extract<ShopifyCommand, { kind: 'order' }>> = {},
    ) {
      return shop.run({
        kind: 'order',
        lines: [
          { variant: '11', quantity: 2, price: '24.00' },
          { variant: '12', quantity: 1, price: '26.50' },
        ],
        location: '1',
        shipping: 'standard',
        financialStatus: 'PAID',
        ...extra,
      });
    },
  };

  return shop;
}
