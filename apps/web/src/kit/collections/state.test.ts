import { inboxCatalog, ordersCatalog } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  builtinState,
  collectionSearch,
  effectiveState,
  hasViewInUrl,
  isModified,
  stateChanges,
  viewKey,
  viewParam,
  viewRef,
  viewSearch,
} from './state';

const savedId = '6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

describe('collection view state', () => {
  it('reads built-in segments and saved views from the existing view parameter', () => {
    expect(viewRef(ordersCatalog, 'overdue')).toEqual({
      kind: 'builtin',
      segment: 'overdue',
    });
    expect(viewRef(ordersCatalog, savedId)).toEqual({
      kind: 'saved',
      id: savedId,
    });
    expect(viewRef(ordersCatalog, 'unknown')).toEqual({
      kind: 'builtin',
      segment: 'all',
    });
    expect(viewParam(viewKey(viewRef(ordersCatalog, 'overdue')))).toBe(
      'overdue',
    );
  });

  it('starts built-in views in the catalog’s first layout', () => {
    expect(builtinState(ordersCatalog, 'all').layout).toBe('table');
    expect(builtinState(inboxCatalog, 'open').layout).toBe('list');
  });

  it('keeps only changes from the view in the URL and reports them as modified', () => {
    const base = builtinState(ordersCatalog, 'overdue');
    const search = collectionSearch.parse({
      view: 'overdue',
      where: {
        match: 'all',
        conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
      },
      sort: 'placed',
      direction: 'asc',
    });
    const next = effectiveState(base, search);
    expect(next.segment).toBe('overdue');
    expect(next.sort).toEqual({ field: 'placed', direction: 'asc' });
    expect(isModified(base, search)).toBe(true);
    expect(isModified(base, collectionSearch.parse({ view: 'overdue' }))).toBe(
      false,
    );
    expect(stateChanges(base, next)).toEqual({
      where: search.where,
      sort: 'placed',
      direction: 'asc',
    });
  });

  it('treats a board without grouping as a table and records grouping changes', () => {
    const base = builtinState(ordersCatalog, 'all');
    expect(
      effectiveState(base, collectionSearch.parse({ layout: 'board' })).layout,
    ).toBe('table');
    const grouped = effectiveState(
      base,
      collectionSearch.parse({ group: 'placed:week', layout: 'board' }),
    );
    expect(grouped.group).toEqual({
      field: 'placed',
      granularity: 'week',
      showEmpty: false,
    });
    expect(grouped.layout).toBe('board');
    expect(stateChanges(base, grouped)).toEqual({
      group: 'placed:week',
      layout: 'board',
    });
  });

  it('recognizes links that carry a view and rebuilds remembered drafts', () => {
    expect(hasViewInUrl({ q: 'A-100', from: '/x' })).toBe(false);
    expect(hasViewInUrl({ view: 'overdue' })).toBe(true);
    const base = builtinState(ordersCatalog, 'all');
    expect(
      viewSearch({ kind: 'builtin', segment: 'all' }, base, {
        ...base,
        layout: 'list',
      }),
    ).toEqual({ view: 'all', layout: 'list' });
  });

  it('drops malformed URL values instead of failing the page', () => {
    expect(
      collectionSearch.parse({
        where: { conditions: [{ field: 'x y', op: 'nope' }] },
        sort: 'DROP TABLE',
        page: 'abc',
      }),
    ).toEqual({});
  });
});
