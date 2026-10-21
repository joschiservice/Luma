import {
  collectionViewStateSchema,
  decisionsCatalog,
} from '@luma/api-contract';
import { expect, it } from 'vitest';

import { builtinState } from '../../kit/collections/state';
import {
  decisionListQuery,
  decisionsOptions,
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

it('keeps the sidebar and Home reads on the whole queue', () => {
  expect(decisionsOptions('org', {}, 1).queryKey).toEqual([
    'private',
    'organization',
    'org',
    'decisions',
    { limit: 1 },
  ]);
});
