import { describe, expect, it } from 'vitest';

import { defaultAutoLinkPairs } from './automatic-links.js';

const connection = (id: string, provider: string) => ({
  id,
  provider,
  status: 'active',
  granted: ['orders.read', 'products.read'],
});

describe('default automatic linking', () => {
  it('connects exact SKU and order identities for reviewed ERP and shipping providers', () => {
    expect(
      defaultAutoLinkPairs([
        connection('shop', 'shopify'),
        connection('erp', 'cin7'),
        connection('shipping', 'starshipit'),
      ]),
    ).toEqual([
      { kind: 'sku', targetConnectionId: 'shop', sourceConnectionId: 'erp' },
      { kind: 'order', targetConnectionId: 'shop', sourceConnectionId: 'erp' },
      {
        kind: 'order',
        targetConnectionId: 'shop',
        sourceConnectionId: 'shipping',
      },
    ]);
  });

  it('does not choose a store among multiple stores, an unsupported provider or an ungranted capability', () => {
    expect(
      defaultAutoLinkPairs([
        connection('a', 'shopify'),
        connection('b', 'shopify'),
        connection('erp', 'jtl'),
      ]),
    ).toEqual([]);
    expect(
      defaultAutoLinkPairs([
        connection('shop', 'shopify'),
        connection('erp', 'unknown'),
      ]),
    ).toEqual([]);
    expect(
      defaultAutoLinkPairs([
        connection('shop', 'shopify'),
        { ...connection('erp', 'jtl'), granted: [] },
      ]),
    ).toEqual([]);
    expect(
      defaultAutoLinkPairs([
        connection('shop', 'shopify'),
        { ...connection('erp', 'jtl'), status: 'revoked' },
      ]),
    ).toEqual([]);
  });
});
