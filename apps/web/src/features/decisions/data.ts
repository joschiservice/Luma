import {
  type CollectionCondition,
  type CollectionGroup,
  type CollectionViewState,
  type DecisionAssignInput,
  decisionDomains,
  type decisionQuerySchema,
  decisionReasons,
  type DecisionView,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { anyOf, withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** The queue request as the API client accepts it. */
export type DecisionListQueryInput = z.input<typeof decisionQuerySchema>;

const decisionViews: readonly DecisionView[] = ['all', 'mine', 'unassigned'];

/** The queue a view value names; saved view IDs and unknown values read the whole queue. */
export function decisionView(value: string | null | undefined): DecisionView {
  return decisionViews.find((view) => view === value) ?? 'all';
}

/**
 * URL state of Needs you: the shared list keys (view, conditions, sort, grouping, display and
 * paging), the open decision and filters of older links. Search can match names in titles, so
 * `q` only arrives with links and the page moves it into page state. Older links name an area
 * or a reason, or ask to group by cause; the route turns them into the view's conditions and
 * grouping.
 */
export const needsYouSearch = z.object({
  ...collectionSearchShape,
  domain: z.enum(decisionDomains).optional().catch(undefined),
  reason: z.enum(decisionReasons).optional().catch(undefined),
  /** The selected decision, kept in the URL so links and Back restore it. */
  item: z.string().max(200).optional().catch(undefined),
  grouped: z.boolean().optional().catch(undefined),
});

export type NeedsYouSearch = z.infer<typeof needsYouSearch>;

/** Whether the URL still uses the filters or the cause switch of older links. */
export function hasLegacyFilters(search: NeedsYouSearch) {
  return Boolean(search.domain || search.reason || search.grouped);
}

/**
 * Rewrites older links, such as Insights' link to procurement decisions, into the same
 * conditions merged with the URL's own, and the cause switch into grouping by cause.
 */
export function withoutLegacyFilters(search: NeedsYouSearch): NeedsYouSearch {
  const conditions: CollectionCondition[] = [
    ...(search.domain ? [anyOf('domain', search.domain)] : []),
    ...(search.reason ? [anyOf('reason', search.reason)] : []),
  ];
  const next: NeedsYouSearch = { ...search };
  delete next.domain;
  delete next.reason;
  delete next.grouped;
  delete next.cursor;
  delete next.page;
  if (search.grouped && next.group === undefined) next.group = 'cause';

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the route must not restore the remembered view. */
export function namesListState(search: NeedsYouSearch) {
  return Boolean(search.item || search.q || search.cursor || search.page);
}

/** The list state without search and paging, so the queue starts on page one. */
export function decisionFilters(search: NeedsYouSearch): NeedsYouSearch {
  const filters = { ...search };
  delete filters.q;
  delete filters.cursor;
  delete filters.page;

  return filters;
}

/** The queue's own ranking, used when a view names no sort. */
export const defaultDecisionSort = {
  field: 'urgency',
  direction: 'asc',
} as const;

const sorts = new Set<string>(['urgency', 'deadline', 'requested']);

export const decisionPageSize = 25;

/** Decisions each group shows before "Show more", and the size of each further page. */
const decisionGroupPageSize = 10;

/**
 * Builds the queue request for a view: its built-in view, conditions (sent only when there are
 * any), sort and grouping, with the private search text and the page cursor. Grouped reads
 * return each group's first decisions; `group` reads one group's next page.
 */
export function decisionListQuery(
  state: CollectionViewState,
  search: { q: string; cursor?: string | undefined },
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): DecisionListQueryInput {
  const grouping = groupOf(state);
  const sort = state.sort ?? defaultDecisionSort;

  return {
    view: decisionView(state.segment),
    q: search.q.trim(),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort: sorts.has(sort.field)
      ? (sort.field as NonNullable<DecisionListQueryInput['sort']>)
      : 'urgency',
    direction: sort.direction,
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: decisionPageSize,
          }
        : { group: grouping, groupLimit: decisionGroupPageSize }
      : { limit: decisionPageSize, cursor: search.cursor }),
  };
}

/** Caches every Needs you read for one workspace so decisions anywhere can refresh them. */
export const decisionsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'decisions'] as const;

/**
 * Loads a page of decisions that need a person, or every group's first decisions. It polls
 * while visible as a fallback for the live stream and refetches on focus and reconnect. Its
 * view counts cover the whole queue, as Home and the sidebar show it.
 */
export function decisionsOptions(
  organizationId: string,
  query: DecisionListQueryInput,
  limit = decisionPageSize,
) {
  const request: DecisionListQueryInput = { limit, ...query };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...decisionsKey(organizationId), request],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.decisions.list(
        { params: { organizationId }, query: request },
        { signal },
      ),
  });
}

/** Takes, hands over or releases a decision at the assignment revision the reader saw. */
export async function assignDecision(
  organizationId: string,
  body: DecisionAssignInput,
) {
  return api.decisions.assign({ params: { organizationId }, body });
}

/** Loads one decision for a direct link to an item outside the current page. */
export function decisionOptions(organizationId: string, id: string) {
  const query = { view: 'all' as const, id, limit: 1 };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...decisionsKey(organizationId), 'item', id],
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const result = await api.decisions.list(
        { params: { organizationId }, query },
        { signal },
      );

      return result.items[0] ?? null;
    },
  });
}
