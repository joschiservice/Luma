import { describe, expect, it } from 'vitest';

import type { AuthorityConnection } from './authority.js';
import { resolveAuthority } from './authority.js';

const shop: AuthorityConnection = {
  id: 'shop',
  label: 'Shopify',
  category: 'storefront',
  available: true,
  capabilities: ['orders.read', 'fulfillment.read', 'inventory.read'],
};
const erp: AuthorityConnection = {
  ...shop,
  id: 'erp',
  label: 'JTL',
  category: 'erp',
};

describe('workspace source authority', () => {
  it('defaults lines and lifecycle to the storefront and fulfillment, tracking and stock to the ERP', () => {
    for (const group of [
      'order_lines',
      'order_lifecycle',
      'inventory_selling',
    ] as const)
      expect(resolveAuthority(group, [erp, shop], {})).toMatchObject({
        state: 'resolved',
        connectionId: shop.id,
        basis: 'default',
      });
    for (const group of [
      'order_fulfillment',
      'order_tracking',
      'inventory_stock',
    ] as const)
      expect(resolveAuthority(group, [erp, shop], {})).toMatchObject({
        state: 'resolved',
        connectionId: erp.id,
      });
  });
  it('supports a lone storefront for fulfillment without guessing stock authority', () => {
    expect(resolveAuthority('order_fulfillment', [shop], {}).connectionId).toBe(
      shop.id,
    );
    expect(resolveAuthority('inventory_stock', [shop], {}).state).toBe(
      'unknown',
    );
  });
  it('does not choose the newest source among equally eligible connections', () => {
    expect(
      resolveAuthority(
        'order_lines',
        [shop, { ...shop, id: 'second' }, erp],
        {},
      ),
    ).toMatchObject({
      state: 'conflicting',
      connectionId: null,
      candidateIds: ['second', 'shop'],
    });
  });
  it('uses explicit overrides across categories', () => {
    expect(
      resolveAuthority('order_lines', [shop, erp], { order_lines: erp.id }),
    ).toMatchObject({
      state: 'resolved',
      connectionId: erp.id,
      basis: 'override',
    });
  });
  it('keeps unavailable, missing and unreadable overrides unknown instead of falling back', () => {
    for (const source of [
      { ...erp, available: false },
      { ...erp, capabilities: [] },
    ])
      expect(
        resolveAuthority('order_fulfillment', [shop, source], {
          order_fulfillment: erp.id,
        }),
      ).toMatchObject({
        state: 'unknown',
        connectionId: null,
        overrideConnectionId: erp.id,
      });
    expect(
      resolveAuthority('order_lines', [shop], { order_lines: 'missing' }).state,
    ).toBe('unknown');
  });
});
