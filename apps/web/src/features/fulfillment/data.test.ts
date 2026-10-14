import {
  collectionWhereIssues,
  fulfillmentCatalog,
  fulfillmentQuerySchema,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import { fulfillmentGroupLabel } from './collection';
import {
  fulfillmentListQuery,
  fulfillmentSearch,
  hasLegacyFilters,
  namesListState,
  withoutLegacyFilters,
} from './data';

const base = builtinState(fulfillmentCatalog, 'attention');
const store = '44444444-4444-4444-8444-444444444444';
const depot = '55555555-5555-4555-8555-555555555555';

describe('fulfillment URL state', () => {
  it('opens on the attention view with the longest wait first', () => {
    const query = fulfillmentListQuery(base, {}, 'Europe/Berlin');
    expect(query).toEqual({
      q: '',
      view: 'attention',
      sort: 'waiting',
      direction: 'asc',
      timeZone: 'Europe/Berlin',
      limit: 50,
      cursor: undefined,
    });
    expect(fulfillmentQuerySchema.safeParse(query).success).toBe(true);
  });

  it('sends conditions, sort direction and grouping the list API accepts', () => {
    const query = fulfillmentListQuery(
      {
        ...base,
        segment: 'all',
        where: {
          match: 'all',
          conditions: [{ field: 'stage', op: 'any_of', value: ['carrier'] }],
        },
        sort: { field: 'fulfillBy', direction: 'desc' },
        group: { field: 'stage', showEmpty: false },
      },
      { q: ' #200 ', cursor: 'ignored' },
      'UTC',
    );
    expect(query).toMatchObject({
      q: '#200',
      view: 'all',
      sort: 'fulfillBy',
      direction: 'desc',
      group: 'stage',
      groupLimit: 10,
    });
    expect(query).not.toHaveProperty('cursor');
    expect(fulfillmentQuerySchema.safeParse(query).success).toBe(true);
  });

  it('restores the remembered view only when the URL names nothing', () => {
    expect(namesListState({})).toBe(false);
    expect(namesListState({ q: '4521' })).toBe(true);
    expect(namesListState({ from: '/app/x/home' })).toBe(true);
  });
});

describe('older fulfillment links', () => {
  it('turns source, location and type filters and the recent sort into the view', () => {
    const search = fulfillmentSearch.parse({
      view: 'open',
      sort: 'recent',
      connectionId: store,
      locationId: depot,
      kind: 'shipment',
      cursor: 'abc',
      from: '/app/x/insights',
    });
    expect(hasLegacyFilters(search)).toBe(true);
    const converted = withoutLegacyFilters(search);
    expect(converted).toEqual({
      view: 'open',
      sort: 'waiting',
      direction: 'desc',
      from: '/app/x/insights',
      where: {
        match: 'all',
        conditions: [
          { field: 'source', op: 'any_of', value: [store] },
          { field: 'location', op: 'any_of', value: [depot] },
          { field: 'kind', op: 'any_of', value: ['shipment'] },
        ],
      },
    });
    expect(hasLegacyFilters(converted)).toBe(false);
    expect(collectionWhereIssues(fulfillmentCatalog, converted.where!)).toEqual(
      [],
    );
  });

  it('names stage, source and date groups', () => {
    expect(fulfillmentGroupLabel('stage', undefined, 'carrier')).toBe(
      'With carrier',
    );
    expect(fulfillmentGroupLabel('stage', undefined, null)).toBe('No value');
    expect(
      fulfillmentGroupLabel('source', undefined, store, {
        connections: [{ value: store, label: 'Tokyo store' }],
      }),
    ).toBe('Tokyo store');
    expect(fulfillmentGroupLabel('hasTracking', undefined, true)).toContain(
      'Yes',
    );
  });
});
