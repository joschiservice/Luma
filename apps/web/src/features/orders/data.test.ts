import { describe, expect, it } from 'vitest';

import { IdentityError } from '../../kit/identity/data';
import {
  orderFilters,
  orderListError,
  orderListQuery,
  ordersSearch,
} from './data';

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

describe('order list errors', () => {
  const invalid = new IdentityError(400, {
    code: 'VALIDATION_ERROR',
    message:
      'This page link no longer matches the order filters. Start from the first page.',
    requestId: 'req-1',
  });

  it('treats a rejected page cursor as a stale page link', () => {
    expect(orderListError(invalid, { cursor: 'abc', page: 3 })).toEqual({
      kind: 'page',
      message:
        'This page link no longer matches the order filters. Start from the first page.',
    });
  });

  it('does not blame the page link when the request had no cursor', () => {
    expect(orderListError(invalid, { q: 'tote' })).toEqual({
      kind: 'unavailable',
    });
    expect(orderListError(new IdentityError(400), { cursor: 'abc' })).toEqual({
      kind: 'unavailable',
    });
  });

  it('reports lost access and unavailable service', () => {
    const notFound = new IdentityError(404, {
      code: 'NOT_FOUND',
      message: 'Organization not found',
      requestId: 'req-2',
    });
    expect(orderListError(notFound, {})).toEqual({ kind: 'access' });
    expect(orderListError(new IdentityError(403), {})).toEqual({
      kind: 'access',
    });
    expect(orderListError(new IdentityError(503), {})).toEqual({
      kind: 'unavailable',
    });
    expect(orderListError(new TypeError('Failed to fetch'), {})).toEqual({
      kind: 'unavailable',
    });
    expect(orderListError(null, {})).toBeUndefined();
  });
});
