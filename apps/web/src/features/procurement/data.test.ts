import { procurementCatalog, suppliersCatalog } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import {
  hasLegacyProcurementKeys,
  namesListState,
  procurementSearch,
  purchaseOrderListQuery,
  supplierListQuery,
  withoutLegacyProcurementKeys,
} from './data';

const supplier = '44444444-4444-4444-8444-444444444444';

describe('procurement URL state', () => {
  it('turns tab names in older links into the tab', () => {
    const search = procurementSearch.parse({ view: 'suppliers', q: 'North' });
    expect(hasLegacyProcurementKeys(search)).toBe(true);
    expect(withoutLegacyProcurementKeys(search)).toEqual({
      tab: 'suppliers',
      q: 'North',
    });
    expect(
      withoutLegacyProcurementKeys(procurementSearch.parse({ view: 'orders' })),
    ).toEqual({});
  });

  it('opens built-in views for stages that have one and conditions otherwise', () => {
    expect(
      withoutLegacyProcurementKeys(
        procurementSearch.parse({ stage: 'attention', cursor: 'stale' }),
      ),
    ).toEqual({ view: 'attention' });
    expect(
      withoutLegacyProcurementKeys(
        procurementSearch.parse({ stage: 'confirmed', status: 'open' }),
      ),
    ).toEqual({
      where: {
        match: 'all',
        conditions: [
          { field: 'stage', op: 'any_of', value: ['confirmed'] },
          { field: 'status', op: 'any_of', value: ['open'] },
        ],
      },
    });
  });

  it('restores the remembered view only when the URL names nothing', () => {
    expect(namesListState(procurementSearch.parse({}))).toBe(false);
    expect(namesListState(procurementSearch.parse({ tab: 'suppliers' }))).toBe(
      false,
    );
    expect(namesListState(procurementSearch.parse({ q: 'PO' }))).toBe(true);
    expect(namesListState(procurementSearch.parse({ tab: 'purchasing' }))).toBe(
      true,
    );
  });
});

describe('procurement list requests', () => {
  it('reads built-in views through the stage parameter', () => {
    const state = builtinState(procurementCatalog, 'awaiting_confirmation');
    expect(purchaseOrderListQuery(state, {}, 'Europe/Berlin')).toMatchObject({
      stage: 'awaiting_confirmation',
      sort: 'created',
      direction: 'desc',
      timeZone: 'Europe/Berlin',
      limit: 50,
    });
    expect(
      purchaseOrderListQuery(
        builtinState(procurementCatalog, 'all'),
        {},
        'UTC',
      ),
    ).not.toHaveProperty('stage');
  });

  it('sends conditions, grouping and group pages', () => {
    const state = {
      ...builtinState(procurementCatalog, 'all'),
      where: {
        match: 'all' as const,
        conditions: [
          { field: 'supplier', op: 'any_of' as const, value: [supplier] },
        ],
      },
      group: { field: 'stage', showEmpty: false },
    };
    const grouped = purchaseOrderListQuery(state, { cursor: 'x' }, 'UTC');
    expect(grouped).toMatchObject({
      where: JSON.stringify(state.where),
      group: 'stage',
      groupLimit: 10,
    });
    expect(grouped).not.toHaveProperty('cursor');
    expect(
      purchaseOrderListQuery(state, {}, 'UTC', {
        key: 'draft',
        cursor: 'next',
      }),
    ).toMatchObject({ groupKey: '"draft"', cursor: 'next' });
  });

  it('sorts suppliers by their catalog sorts', () => {
    expect(
      supplierListQuery(builtinState(suppliersCatalog, 'all'), {}, 'UTC'),
    ).toMatchObject({ sort: 'name', direction: 'asc' });
  });

  it('sends custom-field sorts and falls back for unknown fields', () => {
    const field = `custom:${supplier}`;
    const sorted = (field: string) => ({
      ...builtinState(procurementCatalog, 'all'),
      sort: { field, direction: 'asc' as const },
    });
    expect(purchaseOrderListQuery(sorted(field), {}, 'UTC').sort).toBe(field);
    expect(purchaseOrderListQuery(sorted('nope'), {}, 'UTC').sort).toBe(
      'created',
    );
    expect(supplierListQuery(sorted(field), {}, 'UTC').sort).toBe(field);
  });
});
