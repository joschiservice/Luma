import {
  collectionViewStateSchema,
  collectionWhereIssues,
  ordersCatalog,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import { legacyOrderConditions, orderGroupLabel } from './collection';
import {
  hasLegacyFilters,
  namesListState,
  orderFilters,
  orderListQuery,
  ordersSearch,
  withoutLegacyFilters,
} from './data';

const base = builtinState(ordersCatalog, 'all');

describe('order URL state', () => {
  it('keeps supported keys and drops malformed values', () => {
    expect(
      ordersSearch.parse({
        q: '#1001',
        view: 'overdue',
        status: 'bogus',
        connectionId: 'not-a-uuid',
        placedFrom: '2026-02-30',
        placedTo: '2026-09-01',
        sort: 'placed',
        direction: 'sideways',
        page: '3',
        layout: 'board',
      }),
    ).toEqual({
      q: '#1001',
      view: 'overdue',
      placedTo: '2026-09-01',
      sort: 'placed',
      page: 3,
      layout: 'board',
    });
  });

  it('starts filter changes from the first page without page context', () => {
    expect(
      orderFilters({
        q: 'tote',
        cursor: 'abc',
        page: 4,
        item: '66666666-6666-4666-8666-000000000001',
        from: '/app/x/insights',
      }),
    ).toEqual({ q: 'tote' });
  });

  it('restores the remembered view only when the URL names nothing', () => {
    expect(namesListState({})).toBe(false);
    expect(namesListState({ q: 'SKU-1' })).toBe(true);
    expect(namesListState({ cursor: 'abc', page: 2 })).toBe(true);
    expect(namesListState({ from: '/app/x/home' })).toBe(true);
  });
});

describe('older order links', () => {
  it('converts Insights drill-downs into inclusive calendar-day conditions', () => {
    const search = ordersSearch.parse({
      placedFrom: '2026-09-01',
      placedTo: '2026-09-07',
      status: 'open',
      connectionId: '44444444-4444-4444-8444-444444444444',
      from: '/app/x/insights',
      cursor: 'abc',
      page: '2',
    });
    expect(hasLegacyFilters(search)).toBe(true);
    const converted = withoutLegacyFilters(search);
    expect(converted).toEqual({
      from: '/app/x/insights',
      where: {
        match: 'all',
        conditions: [
          { field: 'status', op: 'any_of', value: ['open'] },
          {
            field: 'source',
            op: 'any_of',
            value: ['44444444-4444-4444-8444-444444444444'],
          },
          {
            field: 'placed',
            op: 'between',
            value: { from: '2026-09-01', to: '2026-09-07' },
          },
        ],
      },
    });
    expect(hasLegacyFilters(converted)).toBe(false);
    expect(collectionWhereIssues(ordersCatalog, converted.where!)).toEqual([]);
  });

  it('keeps metric drill-down instants with an exclusive end', () => {
    expect(
      legacyOrderConditions({
        updatedFrom: '2026-09-01T00:00:00.000Z',
        updatedBefore: '2026-09-02T00:00:00.000Z',
      }),
    ).toEqual([
      {
        field: 'updated',
        op: 'between',
        value: { from: '2026-09-01T00:00:00.000Z', to: null },
      },
      { field: 'updated', op: 'before', value: '2026-09-02T00:00:00.000Z' },
    ]);
  });

  it('adds converted conditions to conditions already in the link', () => {
    const converted = withoutLegacyFilters({
      paymentStatus: 'paid',
      where: {
        match: 'all',
        conditions: [{ field: 'overdue', op: 'is', value: true }],
      },
    });
    expect(converted.where?.conditions).toEqual([
      { field: 'overdue', op: 'is', value: true },
      { field: 'paymentStatus', op: 'any_of', value: ['paid'] },
    ]);
  });
});

describe('order list requests', () => {
  it('sends the segment, sort and paging of a plain view without conditions', () => {
    expect(
      orderListQuery(
        { ...base, segment: 'overdue' },
        { q: ' tote ', cursor: 'abc' },
        'Europe/Berlin',
      ),
    ).toEqual({
      q: 'tote',
      view: 'overdue',
      sort: 'updated',
      direction: 'desc',
      timeZone: 'Europe/Berlin',
      limit: 50,
      cursor: 'abc',
    });
  });

  it('encodes conditions and reads groups without a page cursor', () => {
    const state = collectionViewStateSchema.parse({
      segment: 'all',
      where: {
        match: 'any',
        conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
      },
      sort: { field: 'total', direction: 'asc' },
      group: { field: 'placed', granularity: 'week' },
    });
    const query = orderListQuery(state, { cursor: 'stale' }, 'UTC');
    expect(query).toMatchObject({
      sort: 'total',
      direction: 'asc',
      group: 'placed:week',
      groupLimit: 10,
    });
    expect(query).not.toHaveProperty('cursor');
    expect(JSON.parse(query.where!)).toEqual(state.where);
  });

  it('reads the next page of one group by its key', () => {
    const state = collectionViewStateSchema.parse({
      group: { field: 'overdue' },
    });
    expect(
      orderListQuery(state, {}, 'UTC', { key: null, cursor: 'group-2' }),
    ).toMatchObject({
      group: 'overdue',
      groupKey: 'null',
      cursor: 'group-2',
      limit: 50,
    });
  });

  it('falls back to the default sort for sorts the list cannot read', () => {
    expect(
      orderListQuery(
        { ...base, sort: { field: 'sources', direction: 'asc' } },
        {},
        'UTC',
      ).sort,
    ).toBe('updated');
    expect(
      orderListQuery(
        {
          ...base,
          sort: {
            field: 'custom:11111111-1111-4111-8111-111111111111',
            direction: 'asc',
          },
        },
        {},
        'UTC',
      ).sort,
    ).toBe('custom:11111111-1111-4111-8111-111111111111');
  });
});

describe('group names', () => {
  it('names options, sources, periods and missing values', () => {
    expect(orderGroupLabel('status', undefined, 'open')).toBe('Open');
    expect(orderGroupLabel('status', undefined, null)).toBe('No value');
    expect(orderGroupLabel('overdue', undefined, true)).toBe('Overdue: Yes');
    expect(
      orderGroupLabel('source', undefined, 'c1', {
        connections: [{ value: 'c1', label: 'Tokyo store' }],
      }),
    ).toBe('Tokyo store');
    expect(orderGroupLabel('placed', 'day', '2026-10-08')).toBe('8 Oct 2026');
    expect(orderGroupLabel('placed', 'week', '2026-10-05')).toBe(
      'Week of 5 Oct 2026',
    );
    expect(orderGroupLabel('placed', 'month', '2026-10-01')).toBe(
      'October 2026',
    );
  });
});
