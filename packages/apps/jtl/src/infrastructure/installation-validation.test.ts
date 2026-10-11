import { describe, expect, it } from 'vitest';

import { installationInput } from './installation-validation.js';

const input = (permissions: string[]) => ({
  label: 'ERP',
  target: {
    kind: 'jtl-cloud',
    jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  },
  credentials: { token: 'private-token' },
  permissions,
});

describe('JTL installation input', () => {
  it('accepts customer import as an optional read', () => {
    expect(
      installationInput.parse(input(['orders.read', 'customers.read']))
        .permissions,
    ).toEqual(['orders.read', 'customers.read']);
  });

  it('accepts every option together', () => {
    expect(
      installationInput.parse(
        input([
          'orders.read',
          'products.read',
          'inventory.read',
          'fulfillment.read',
          'customers.read',
          'orders.shipping-method.read',
          'orders.shipping-method.write',
          'suppliers.read',
          'purchase-orders.read',
          'purchase-orders.submit',
          'returns.options.read',
          'returns.created.read',
          'returns.create',
        ]),
      ).permissions,
    ).toHaveLength(13);
  });

  it('requires the order and return reads that return creation performs first', () => {
    expect(() =>
      installationInput.parse(
        input(['orders.read', 'returns.created.read', 'returns.create']),
      ),
    ).toThrow();
    expect(() =>
      installationInput.parse(
        input([
          'orders.read',
          'returns.options.read',
          'returns.created.read',
          'returns.create',
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects capabilities JTL does not offer', () => {
    expect(() => installationInput.parse(input(['returns.read']))).toThrow();
  });
});
