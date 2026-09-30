import { describe, expect, it } from 'vitest';

import { productFilters, productListQuery, productsSearch } from './data';

describe('product URL state', () => {
  it('keeps supported filters and drops malformed values', () => {
    expect(
      productsSearch.parse({
        q: 'LINEN',
        view: 'bogus',
        connectionId: 'not-a-uuid',
        missingFrom: '55555555-5555-4555-8555-555555555555',
        cursor: 'abc',
      }),
    ).toEqual({
      q: 'LINEN',
      missingFrom: '55555555-5555-4555-8555-555555555555',
      cursor: 'abc',
    });
  });

  it('starts filter changes on the first page and keeps the return context out', () => {
    expect(
      productFilters({ q: 'x', view: 'missing', cursor: 'c', from: '/app/o' }),
    ).toEqual({ q: 'x', view: 'missing' });
    expect(productListQuery({ q: '  tote ' })).toEqual({
      q: 'tote',
      view: 'all',
      connectionId: undefined,
      missingFrom: undefined,
      cursor: undefined,
    });
  });
});
