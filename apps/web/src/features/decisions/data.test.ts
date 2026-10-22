import {
  collectionViewStateSchema,
  decisionsCatalog,
} from '@luma/api-contract';
import { expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import {
  attentionOptions,
  decisionListQuery,
  decisionsOptions,
  decisionsRefresh,
  hasLegacyFilters,
  needsYouSearch,
  withoutLegacyFilters,
} from './data';

it('turns older area, reason and cause links into the same view', () => {
  const search = needsYouSearch.parse({
    domain: 'procurement',
    reason: 'approval',
    grouped: true,
    item: 'case:1',
    cursor: 'old',
  });
  expect(hasLegacyFilters(search)).toBe(true);
  expect(withoutLegacyFilters(search)).toEqual({
    item: 'case:1',
    group: 'cause',
    where: {
      match: 'all',
      conditions: [
        { field: 'domain', op: 'any_of', value: ['procurement'] },
        { field: 'reason', op: 'any_of', value: ['approval'] },
      ],
    },
  });
  expect(hasLegacyFilters(needsYouSearch.parse({ domain: 'nowhere' }))).toBe(
    false,
  );
});

it('sends conditions, sort and grouping, with search kept out of the view', () => {
  const state = collectionViewStateSchema.parse({
    ...builtinState(decisionsCatalog, 'mine'),
    where: {
      match: 'all',
      conditions: [
        { field: 'owner', op: 'any_of', value: [{ dynamic: 'me' }] },
      ],
    },
    sort: { field: 'deadline', direction: 'asc' },
  });
  expect(decisionListQuery(state, { q: ' draft ' }, 'UTC')).toEqual({
    view: 'mine',
    q: 'draft',
    where: JSON.stringify(state.where),
    sort: 'deadline',
    direction: 'asc',
    timeZone: 'UTC',
    limit: 25,
    cursor: undefined,
  });
  expect(
    decisionListQuery(
      { ...state, group: { field: 'cause', showEmpty: false } },
      { q: '' },
      'UTC',
    ),
  ).toMatchObject({ group: 'cause', groupLimit: 10 });
});

it('shares one whole-queue read between the sidebar and Home', () => {
  expect(attentionOptions('org').queryKey).toEqual([
    'private',
    'organization',
    'org',
    'decisions',
    { limit: 5 },
  ]);
});

it('polls Needs you reads only while the live stream is not delivering', () => {
  expect(decisionsRefresh('live')).toEqual({
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  for (const stream of [undefined, 'connecting', 'interrupted'] as const)
    expect(decisionsRefresh(stream)).toEqual({
      refetchInterval: 30_000,
      refetchOnWindowFocus: 'always',
      staleTime: 0,
    });
  expect(decisionsOptions('org', {}).refetchInterval).toBe(30_000);
});
