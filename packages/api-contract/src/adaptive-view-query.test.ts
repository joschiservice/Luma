import { describe, expect, it } from 'vitest';

import {
  adaptiveViewQueryInputSchema,
  adaptiveViewQueryV1Schema,
  upgradeAdaptiveViewQuery,
} from './adaptive-view-query.js';
import { collectionWhereIssues, ordersCatalog } from './collection-catalog.js';

const fieldId = '6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

describe('saved view upgrade', () => {
  it('maps an orders view to catalog fields, segments and operators', () => {
    const upgraded = upgradeAdaptiveViewQuery(
      adaptiveViewQueryV1Schema.parse({
        version: 1,
        domain: 'orders',
        filters: { view: 'stuck', status: 'open', stockBlocked: true },
        customFilters: [
          { fieldId, operator: 'gte', value: 3 },
          { fieldId, operator: 'is_empty', value: null },
        ],
        columns: ['id', 'displayNumber', 'status', 'dueAt'],
        sort: { field: 'placed', direction: 'asc' },
        groupBy: 'status',
        layout: 'board',
      }),
    );
    expect(upgraded.state).toMatchObject({
      segment: 'stuck',
      sort: { field: 'placed', direction: 'asc' },
      group: { field: 'status', showEmpty: false },
      layout: 'board',
      columns: [{ id: 'number' }, { id: 'status' }, { id: 'due' }],
    });
    expect(upgraded.state.where.conditions).toEqual([
      { field: 'status', op: 'any_of', value: ['open'] },
      { field: 'stockBlocked', op: 'is', value: true },
      { field: `custom:${fieldId}`, op: 'gte', value: 3 },
      { field: `custom:${fieldId}`, op: 'empty' },
    ]);
    expect(
      collectionWhereIssues(ordersCatalog, {
        match: 'all',
        conditions: upgraded.state.where.conditions.slice(0, 2),
      }),
    ).toEqual([]);
  });

  it('keeps unmapped filters so the view needs repair rather than widening', () => {
    const upgraded = upgradeAdaptiveViewQuery(
      adaptiveViewQueryV1Schema.parse({
        version: 1,
        domain: 'orders',
        filters: { q: 'A-100' },
        columns: ['status'],
      }),
    );
    expect(upgraded.state.where.conditions).toEqual([
      { field: 'q', op: 'any_of', value: ['A-100'] },
    ]);
    expect(
      collectionWhereIssues(ordersCatalog, upgraded.state.where),
    ).toHaveLength(1);
  });

  it('renames metric, chart and action row fields with the columns', () => {
    const upgraded = upgradeAdaptiveViewQuery(
      adaptiveViewQueryV1Schema.parse({
        version: 1,
        domain: 'procurement',
        filters: { attention: 'confirmation_overdue' },
        columns: ['reference', 'supplierName'],
        groupBy: 'supplierName',
        metrics: [{ id: 'count', operation: 'count' }],
        charts: [
          {
            id: 'by-supplier',
            type: 'bar',
            groupBy: 'supplierName',
            metricId: 'count',
          },
        ],
      }),
    );
    expect(upgraded.state.group).toEqual({
      field: 'supplier',
      showEmpty: false,
    });
    expect(upgraded.charts[0]?.groupBy).toBe('supplier');
    expect(upgraded.state.where.conditions).toEqual([
      { field: 'attention', op: 'any_of', value: ['confirmation_overdue'] },
    ]);
  });

  it('accepts both formats as input and upgrades format 2 unchanged', () => {
    const v1 = adaptiveViewQueryInputSchema.parse({
      version: 1,
      domain: 'orders',
      columns: ['displayNumber'],
    });
    expect(upgradeAdaptiveViewQuery(v1).state.columns).toEqual([
      { id: 'number' },
    ]);
    const v2 = adaptiveViewQueryInputSchema.parse({
      version: 2,
      domain: 'returns',
      state: { segment: 'action' },
      metrics: [],
      charts: [],
      actions: [],
    });
    expect(upgradeAdaptiveViewQuery(v2)).toBe(v2);
    expect(
      adaptiveViewQueryInputSchema.safeParse({ version: 3, domain: 'orders' })
        .success,
    ).toBe(false);
  });
});
