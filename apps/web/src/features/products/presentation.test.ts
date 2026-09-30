import type { CatalogItem, CatalogSource } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  catalogState,
  differenceSentence,
  formatPrice,
  gapText,
  listingLabel,
} from './presentation';

const source: CatalogSource = {
  connectionId: '55555555-5555-4555-8555-555555555555',
  label: 'JTL-Wawi',
  system: 'jtl-onprem',
  status: 'active',
  skuCount: 3,
  fullReadAt: null,
  lastReadAt: null,
  failing: false,
};

const item = (patch: Partial<CatalogItem>): CatalogItem => ({
  skuId: '22222222-2222-4222-8222-222222222222',
  sku: 'SKU-1',
  skuKey: 'SKU-1',
  title: 'Tote',
  listings: [],
  differences: [],
  gaps: [],
  ...patch,
});

describe('product presentation', () => {
  it('never converts or compares prices without a currency', () => {
    expect(formatPrice({ amount: '26.00', currency: null })).toBe(
      '26.00 (currency not reported)',
    );
    expect(formatPrice({ amount: '26.5', currency: 'EUR' }, 'en')).toBe(
      '€26.50',
    );
    expect(formatPrice(null)).toBeNull();
  });

  it('describes listings in each system’s terms and keeps unknown visible', () => {
    expect(listingLabel(true, 'shopify')).toBe('Published to Online Store');
    expect(listingLabel(false, 'jtl-cloud')).toBe('Not active for shops');
    expect(listingLabel(null, 'shopify')).toBe('Not reported');
  });

  it('distinguishes confirmed absence, unread catalogs and possible matches', () => {
    const asOf = '2026-09-30T09:00:00Z';
    expect(
      gapText({ connectionId: source.connectionId, match: null }, source, asOf),
    ).toMatch('full catalog has not been read yet');
    expect(
      gapText(
        { connectionId: source.connectionId, match: null },
        { ...source, fullReadAt: '2026-09-30T07:00:00Z' },
        asOf,
      ),
    ).toBe(
      'JTL-Wawi does not list this SKU. Its full catalog was read 2h ago.',
    );
    expect(
      gapText(
        {
          connectionId: source.connectionId,
          match: { skuId: source.connectionId, sku: 'SKU-1 ' },
        },
        source,
        asOf,
      ),
    ).toMatch('same code (SKU-1)');
  });

  it('puts differences before gaps when summarizing a SKU', () => {
    const gap = { connectionId: source.connectionId, match: null };
    expect(
      catalogState(item({ differences: ['price'], gaps: [gap] }), [source])
        .label,
    ).toBe('Differs by source');
    expect(catalogState(item({ gaps: [gap] }), [source]).label).toBe(
      'Not in any catalog',
    );
    expect(differenceSentence(['title', 'published', 'price'])).toBe(
      'Sources disagree on title, sales channel and price.',
    );
  });
});
