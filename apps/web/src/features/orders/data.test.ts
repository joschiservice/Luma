import { describe, expect, it } from 'vitest';

import { orderFilters, orderListQuery, ordersSearch } from './data';

describe('order URL state', () => {
  it('keeps supported filters and drops malformed values', () => {
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
      }),
    ).toEqual({
      q: '#1001',
      view: 'overdue',
      placedTo: '2026-09-01',
      sort: 'placed',
      page: 3,
    });
  });

  it('resolves placed days in the workspace time zone with an exclusive end', () => {
    expect(
      orderListQuery(
        { placedFrom: '2026-09-01', placedTo: '2026-09-01' },
        'Asia/Tokyo',
      ),
    ).toMatchObject({
      q: '',
      view: 'all',
      sort: 'updated',
      direction: 'desc',
      placedFrom: '2026-08-31T15:00:00.000Z',
      placedBefore: '2026-09-01T15:00:00.000Z',
      limit: 50,
    });
  });

  it('starts filter changes from the first page', () => {
    expect(
      orderFilters({
        q: 'tote',
        cursor: 'abc',
        page: 4,
        from: '/app/x/insights',
      }),
    ).toEqual({ q: 'tote' });
  });
});
