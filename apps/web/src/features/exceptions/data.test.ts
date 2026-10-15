import {
  type CaseSummary,
  collectionViewStateSchema,
  issuesCatalog,
} from '@luma/api-contract';
import { caseFixture } from '@luma/ui/components/issues/case-fixtures';
import { expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import {
  caseListQuery,
  caseOptions,
  casesOptions,
  caseView,
  hasLegacyFilters,
  inboxSearch,
  matchesView,
  withoutLegacyFilters,
} from './data';

it('drops invalid deep-link filters and converts older ones into conditions', () => {
  const invalid = inboxSearch.parse({
    view: 'invalid',
    class: 'unknown',
    severity: 42,
    state: 'bad',
  });
  expect(hasLegacyFilters(invalid)).toBe(false);
  expect(caseView(invalid.view)).toBe('active');

  const owner = '6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
  const legacy = inboxSearch.parse({
    view: 'active',
    class: 'inventory_mismatch',
    severity: 'high',
    ownerId: owner,
    cursor: 'old-page',
  });
  expect(hasLegacyFilters(legacy)).toBe(true);
  const converted = withoutLegacyFilters(legacy);
  expect(converted).toEqual({
    view: 'active',
    where: {
      match: 'all',
      conditions: [
        { field: 'owner', op: 'any_of', value: [owner] },
        { field: 'class', op: 'any_of', value: ['inventory_mismatch'] },
        { field: 'severity', op: 'any_of', value: ['high'] },
      ],
    },
  });
  expect(
    withoutLegacyFilters(inboxSearch.parse({ ownerId: 'unassigned' })).where,
  ).toEqual({ match: 'all', conditions: [{ field: 'owner', op: 'empty' }] });
});

it('reads built-in views and defaults missing segments to All open', () => {
  expect(caseView('history')).toBe('history');
  expect(caseView('6f8a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b')).toBe('active');
  expect(caseView(undefined)).toBe('active');
});

it('retains failed and escalated work in active, and only explicit attention in needs you', () => {
  const item: CaseSummary = {
    ...caseFixture('sync_failure'),
    class: 'inventory_mismatch',
    state: 'failed',
    severity: 'high',
    sources: ['shopify'],
    attention: {
      required: false,
      reason: null,
      explanation: '',
      requestedAt: null,
    },
    freshness: 'stale',
  };
  const none = { match: 'all' as const, conditions: [] };
  expect(matchesView(item, { segment: null, where: none })).toBe(true);
  expect(
    caseListQuery(builtinState(issuesCatalog, 'active'), { q: '' }, 'UTC').view,
  ).toBe('active');
  expect(matchesView(item, { segment: 'needs_you', where: none })).toBe(false);
  expect(matchesView(item, { segment: 'active', where: none })).toBe(true);
  expect(
    matchesView(
      { ...item, state: 'escalated' },
      { segment: 'history', where: none },
    ),
  ).toBe(false);
  expect(
    matchesView(
      { ...item, state: 'resolved' },
      { segment: 'history', where: none },
    ),
  ).toBe(true);
  const where = (field: string, value: string[]) => ({
    match: 'all' as const,
    conditions: [{ field, op: 'any_of' as const, value }],
  });
  expect(
    matchesView(item, {
      segment: 'active',
      where: where('severity', ['medium']),
    }),
  ).toBe(false);
  // Stale evidence never counts as fresh.
  expect(
    matchesView(item, {
      segment: 'active',
      where: where('freshness', ['fresh']),
    }),
  ).toBe(false);
  expect(
    matchesView(item, {
      segment: 'active',
      where: where('source', ['shopify']),
    }),
  ).toBe(true);
});

it('sends conditions, sort and grouping, and keeps search out of the view', () => {
  const state = collectionViewStateSchema.parse({
    ...builtinState(issuesCatalog, 'active'),
    where: {
      match: 'all',
      conditions: [{ field: 'class', op: 'any_of', value: ['sync_failure'] }],
    },
  });
  expect(caseListQuery(state, { q: ' SKU-1 ' }, 'Europe/Berlin')).toEqual({
    view: 'active',
    q: 'SKU-1',
    where: JSON.stringify(state.where),
    sort: 'urgency',
    direction: 'asc',
    timeZone: 'Europe/Berlin',
    limit: 25,
    cursor: undefined,
  });
  const grouped = collectionViewStateSchema.parse({
    ...state,
    group: { field: 'state' },
    layout: 'board',
  });
  expect(caseListQuery(grouped, { q: '' }, 'UTC')).toMatchObject({
    group: 'state',
    groupLimit: 10,
  });
  expect(
    caseListQuery(grouped, { q: '' }, 'UTC', { key: 'failed', cursor: 'c' }),
  ).toMatchObject({ group: 'state', groupKey: '"failed"', cursor: 'c' });
});

it('separates tenant, selection and filter caches and refetches on focus', () => {
  expect(casesOptions('a', { view: 'active' }).queryKey).not.toEqual(
    casesOptions('b', { view: 'active' }).queryKey,
  );
  expect(caseOptions('a', 'first').queryKey).not.toEqual(
    caseOptions('a', 'second').queryKey,
  );
  expect(caseOptions('a', 'first').refetchOnWindowFocus).toBe('always');
});
