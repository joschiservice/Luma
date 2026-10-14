import {
  procurementCatalog,
  purchaseOrderSortSchema,
  suppliersCatalog,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import type { ListFields } from '../application/list-conditions.js';
import { supplierFields } from '../application/procurement.js';
import {
  listedAttentionKinds,
  nextOwners,
  purchaseOrderAuthorities,
  purchaseOrderFields,
  purchaseOrderGroupField,
  purchaseOrderStages,
  purchaseOrderStatuses,
} from '../application/purchase-order-list.js';
import {
  validatePurchaseOrderListQuery,
  validateSupplierListQuery,
} from './procurement.js';

const filters = <T>(fields: ListFields<T>) =>
  Object.fromEntries(
    Object.entries(fields).map(([id, field]) => [
      id,
      [...field.operators].sort(),
    ]),
  );

describe('procurement list catalogs', () => {
  it('offer exactly the filters the server evaluates', () => {
    const offered = (catalog: typeof procurementCatalog) =>
      Object.fromEntries(
        catalog.fields.flatMap((field) =>
          field.filter ? [[field.id, [...field.filter].sort()]] : [],
        ),
      );
    expect(offered(procurementCatalog)).toEqual(filters(purchaseOrderFields));
    expect(offered(suppliersCatalog)).toEqual(filters(supplierFields));
  });

  it('offer the server’s sorts, groups and options in its order', () => {
    expect(
      procurementCatalog.fields
        .filter((field) => field.sort)
        .map((field) => field.id)
        .sort(),
    ).toEqual([...purchaseOrderSortSchema.options].sort());
    expect(
      procurementCatalog.fields
        .filter((field) => field.group)
        .map((field) => field.id),
    ).toEqual(
      procurementCatalog.fields
        .map((field) => field.id)
        .filter((id) => {
          try {
            purchaseOrderGroupField(id);

            return true;
          } catch {
            return false;
          }
        }),
    );
    const options = (id: string) =>
      procurementCatalog.fields.find((field) => field.id === id)?.options;
    expect(options('stage')).toEqual(purchaseOrderStages);
    expect(options('attention')).toEqual(listedAttentionKinds);
    expect(options('status')).toEqual(purchaseOrderStatuses);
    expect(options('nextOwner')).toEqual(nextOwners);
    expect(options('authority')).toEqual(purchaseOrderAuthorities);
  });
});

describe('procurement list validation', () => {
  const rejects = (run: () => void, message: string) =>
    expect(run).toThrow(
      expect.objectContaining({ statusCode: 400, expose: true, message }),
    );

  it('names the first invalid condition and checks grouping', () => {
    rejects(
      () =>
        validatePurchaseOrderListQuery({
          where: {
            match: 'all',
            conditions: [
              { field: 'stage', op: 'any_of', value: ['draft'] },
              { field: 'stage', op: 'contains', value: 'dr' },
            ],
          },
        }),
      'Condition 2: This field does not support this operator.',
    );
    rejects(
      () =>
        validatePurchaseOrderListQuery({
          where: {
            match: 'all',
            conditions: [
              {
                field: 'attention',
                op: 'any_of',
                value: ['submission_approval'],
              },
            ],
          },
        }),
      'Condition 1: This value is not one of the field’s options.',
    );
    rejects(
      () => validatePurchaseOrderListQuery({ group: { field: 'expected' } }),
      'This field cannot be grouped.',
    );
    rejects(
      () => validatePurchaseOrderListQuery({ groupKey: 'draft' }),
      'Choose a grouping to read one group.',
    );
    rejects(
      () =>
        validatePurchaseOrderListQuery({
          group: { field: 'stage' },
          cursor: 'next',
        }),
      'Use a group’s page link together with its group key.',
    );
    expect(() =>
      validatePurchaseOrderListQuery({
        group: { field: 'stage' },
        groupKey: 'draft',
        cursor: 'next',
      }),
    ).not.toThrow();
    rejects(
      () =>
        validateSupplierListQuery({
          where: {
            match: 'any',
            conditions: [{ field: 'name', op: 'contains', value: 'a' }],
          },
        }),
      'Condition 1: This field cannot be filtered.',
    );
  });

  it('leaves custom-field conditions to the list and keeps condition positions', () => {
    const custom = {
      field: 'custom:6d5f0c1a-2b3c-4d5e-8f90-1a2b3c4d5e6f',
      op: 'empty' as const,
    };
    expect(() =>
      validatePurchaseOrderListQuery({
        where: { match: 'all', conditions: [custom] },
      }),
    ).not.toThrow();
    rejects(
      () =>
        validateSupplierListQuery({
          where: {
            match: 'all',
            conditions: [custom, { field: 'name', op: 'contains', value: 'a' }],
          },
        }),
      'Condition 2: This field cannot be filtered.',
    );
  });
});
