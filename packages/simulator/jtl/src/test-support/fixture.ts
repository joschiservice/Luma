import {
  createMemoryStore,
  type ProviderEvent,
  type ProviderRequest,
} from '@luma/simulator-core';

import { jtl } from '../index.js';
import type { JtlContext } from '../records.js';
import type { JtlConfig, JtlSeedItem, JtlSeedSupplier } from '../types.js';

export const start = Date.parse('2026-10-01T08:00:00Z');

export const config: JtlConfig = {
  warehouses: [
    { id: '1', name: 'Hamburg' },
    { id: '2', name: 'Leipzig' },
  ],
  shippingMethods: [
    { id: '7', name: 'Standard' },
    { id: '8', name: 'Express' },
    { id: '9', name: 'Pickup' },
  ],
};

export const suppliers: JtlSeedSupplier[] = [
  {
    id: '1',
    companyName: 'Nordwind Textil GmbH',
    supplierNumber: 'L-1001',
    city: 'Hamburg',
    countryIso: 'DE',
    email: 'orders@nordwind-textil.example',
    profile: 'full',
  },
  {
    id: '2',
    companyName: 'Baltic Packaging AB',
    supplierNumber: 'L-1002',
    city: 'Malmö',
    countryIso: 'SE',
    email: 'purchasing@baltic-packaging.example',
    profile: 'partial',
  },
];

export const items: JtlSeedItem[] = [
  {
    id: '1',
    sku: 'LUMA-001',
    name: 'Canvas tote',
    price: '24.00',
    gtin: '4006381333931',
    manufacturer: 'Luma Goods',
    active: true,
    shopActive: true,
    stock: { '1': 100, '2': 20 },
    suppliers: [
      { supplierId: '1', netPrice: 9.5, isDefault: true },
      { supplierId: '2', netPrice: 10.2, isDefault: false },
    ],
  },
  {
    id: '2',
    sku: 'LUMA-002',
    name: 'Linen shirt',
    price: '59.90',
    gtin: null,
    manufacturer: 'Nordwind',
    active: true,
    shopActive: false,
    stock: { '1': 5 },
    suppliers: [{ supplierId: '1', netPrice: 21, isDefault: true }],
  },
];

/** Creates an empty JTL instance with a recording notifier. */
export function createFixture() {
  const events: ProviderEvent[] = [];
  const context: JtlContext = {
    store: createMemoryStore(),
    now: start,
    wallTime: start,
    instance: 'jtl',
    config,
    indexLagMs: 0,
    notify: (event) => events.push(event),
  };

  return { context, events };
}

/** Creates a JTL instance seeded with the fixture catalog. */
export async function seeded() {
  const fixture = createFixture();
  await jtl.command(fixture.context, {
    kind: 'seed-catalog',
    items,
    suppliers,
  });
  fixture.events.length = 0;

  return fixture;
}

/** Builds an authenticated on-premise ERP API request. */
export function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): ProviderRequest {
  return {
    url: `https://jtl.invalid/api/eazybusiness/${path}`,
    method,
    headers: {
      authorization: 'Wawi synthetic',
      'x-appid': 'Luma/1',
      'x-appversion': '1.0.0',
      ...headers,
    },
    body: body === undefined ? null : JSON.stringify(body),
  };
}

/** Sends an authenticated request and returns the response. */
export function call(
  context: JtlContext,
  path: string,
  method = 'GET',
  body?: unknown,
  headers?: Record<string, string>,
) {
  return jtl.handle(context, request(path, method, body, headers));
}

/** Places an order for the fixture tote and returns its result. */
export function order(context: JtlContext, quantity = 3, id?: string) {
  return jtl.command(context, {
    kind: 'order',
    ...(id ? { id } : {}),
    externalNumber: '#1001',
    lines: [{ itemId: '1', quantity, price: 24 }],
    shippingMethodId: '7',
    currency: 'EUR',
    paid: true,
  });
}
