import {
  collectionWhereIssues,
  productQuerySchema,
  productsCatalog,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import {
  listingColumn,
  listingColumnSource,
  productGroupLabel,
} from './collection';
import {
  hasLegacyFilters,
  namesListState,
  productFilters,
  productListQuery,
  productsSearch,
  withoutLegacyFilters,
} from './data';

const base = builtinState(productsCatalog, 'all');
const erp = '55555555-5555-4555-8555-555555555555';

describe('product URL state', () => {
  it('keeps supported keys and drops malformed values', () => {
    expect(
      productsSearch.parse({
        q: 'LINEN',
        view: 'missing',
        connectionId: 'not-a-uuid',
        sort: 'price',
        direction: 'sideways',
        cursor: 'abc',
      }),
    ).toEqual({ q: 'LINEN', view: 'missing', sort: 'price', cursor: 'abc' });
  });

  it('starts filter changes on the first page and keeps the return context out', () => {
    expect(
      productFilters({
        q: 'x',
        view: 'missing',
        cursor: 'c',
        page: 2,
        from: '/app/o',
      }),
    ).toEqual({ q: 'x', view: 'missing' });
    expect(namesListState({})).toBe(false);
    expect(namesListState({ q: 'tote' })).toBe(true);
  });

  it('lists in catalog order until a view sorts', () => {
    const query = productListQuery(base, { q: '  tote ' }, 'UTC');
    expect(query).toEqual({
      q: 'tote',
      view: 'all',
      sort: 'rank',
      direction: 'asc',
      timeZone: 'UTC',
      limit: 50,
      cursor: undefined,
    });
    expect(productQuerySchema.safeParse(query).success).toBe(true);
  });

  it('sends per-source conditions, the sort direction and grouping', () => {
    const query = productListQuery(
      {
        ...base,
        segment: 'differs',
        where: {
          match: 'all',
          conditions: [
            { field: 'status', op: 'any_of', value: ['draft'], source: erp },
          ],
        },
        sort: { field: 'price', direction: 'desc' },
        group: { field: 'vendor', showEmpty: false },
      },
      {},
      'Europe/Berlin',
    );
    expect(query).toMatchObject({
      view: 'differs',
      sort: 'price',
      direction: 'desc',
      group: 'vendor',
      groupLimit: 10,
    });
    expect(productQuerySchema.safeParse(query).success).toBe(true);
  });

  it('sends custom-field sorts, which the server checks', () => {
    const field = 'custom:6d5f0c1a-2b3c-4d5e-8f90-1a2b3c4d5e6f';
    const query = productListQuery(
      { ...base, sort: { field, direction: 'desc' } },
      {},
      'UTC',
    );
    expect(query).toMatchObject({ sort: field, direction: 'desc' });
    expect(productQuerySchema.safeParse(query).success).toBe(true);
  });
});

describe('older product links', () => {
  it('turns Listed in and Missing from filters into conditions', () => {
    const converted = withoutLegacyFilters(
      productsSearch.parse({
        view: 'missing',
        missingFrom: erp,
        cursor: 'abc',
      }),
    );
    expect(converted).toEqual({
      view: 'missing',
      where: {
        match: 'all',
        conditions: [{ field: 'missing', op: 'any_of', value: [erp] }],
      },
    });
    expect(hasLegacyFilters(converted)).toBe(false);
    expect(collectionWhereIssues(productsCatalog, converted.where!)).toEqual(
      [],
    );
  });
});

describe('product columns and groups', () => {
  it('round-trips a source through its listing column ID', () => {
    const column = listingColumn(erp);
    expect(column).toMatch(/^[a-z][a-zA-Z0-9]{0,63}$/);
    expect(listingColumnSource(column)).toBe(erp);
    expect(listingColumnSource('sku')).toBeNull();
  });

  it('names status and difference groups', () => {
    expect(productGroupLabel('status', undefined, 'draft')).toBe('Draft');
    expect(productGroupLabel('differences', undefined, 'price')).toBe('Price');
    expect(productGroupLabel('vendor', undefined, 'Acme')).toBe('Acme');
    expect(productGroupLabel('vendor', undefined, null)).toBe('No value');
  });
});
