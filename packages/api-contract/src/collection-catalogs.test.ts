import { describe, expect, it } from 'vitest';

import { collectionWhereIssues } from './collection-catalog.js';
import {
  inventoryCatalog,
  productsCatalog,
  transfersCatalog,
} from './collection-catalogs.js';
import { inventoryQuerySchema } from './inventory.js';
import { transferQuerySchema } from './inventory-transfers.js';
import { productQuerySchema } from './products.js';

describe('catalog list fields', () => {
  it('declare only sorts the list API accepts', () => {
    for (const [catalog, schema] of [
      [productsCatalog, productQuerySchema],
      [inventoryCatalog, inventoryQuerySchema],
      [transfersCatalog, transferQuerySchema],
    ] as const)
      for (const field of catalog.fields.filter((item) => item.sort))
        expect(
          schema.shape.sort.safeParse(field.id).success,
          `${catalog.domain}.${field.id}`,
        ).toBe(true);
  });

  it('accept source scopes on per-source fields and the lowest value only for quantities', () => {
    const source = '6d5f0c1a-2b3c-4d5e-8f90-1a2b3c4d5e6f';
    const issues = (
      catalog: typeof inventoryCatalog,
      condition: Parameters<
        typeof collectionWhereIssues
      >[1]['conditions'][number],
    ) =>
      collectionWhereIssues(catalog, {
        match: 'all',
        conditions: [condition],
      }).map((issue) => issue.message);

    expect(
      issues(inventoryCatalog, {
        field: 'available',
        op: 'lte',
        value: 0,
        source: 'lowest',
      }),
    ).toEqual([]);
    expect(
      issues(productsCatalog, {
        field: 'price',
        op: 'gt',
        value: { amount: '10', currency: 'EUR' },
        source,
      }),
    ).toEqual([]);
    expect(
      issues(inventoryCatalog, {
        field: 'tracked',
        op: 'is',
        value: true,
        source: 'lowest',
      }),
    ).toEqual(['Only quantities can use the lowest value of all sources']);
    expect(
      issues(inventoryCatalog, {
        field: 'location',
        op: 'any_of',
        value: [source],
        source: 'every',
      }),
    ).toEqual(['This field has one value for all sources']);
  });
});
