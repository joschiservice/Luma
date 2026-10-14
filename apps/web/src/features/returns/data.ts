import {
  type CollectionGroup,
  type CollectionViewState,
  type returnQuerySchema,
  returnStageSchema,
  returnViewSchema,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import {
  chosenStage,
  legacyReturnConditions,
  segmentSort,
  withStage,
} from './collection';

const api = createWebApiClient();

/** The list request as the API client accepts it. */
export type ReturnListQueryInput = z.input<typeof returnQuerySchema>;

/** Page context the Returns pages carry besides the view. */
const contextShape = {
  /** The return open in the preview pane. */
  item: z.uuid().optional().catch(undefined),
  /** The record page the list was opened from, for its back link. */
  from: z.string().max(2048).optional().catch(undefined),
};

/**
 * URL state of the Returns list and return pages: the shared list keys (view, conditions, sort,
 * grouping, display and paging), filters of older links and page context. Search can match
 * customer names and email addresses: `q` only arrives with links, and the page moves it into
 * page state. Older links name a stage, a source, or `oldest` and `newest` as the sort.
 */
export const returnsSearch = z.object({
  ...collectionSearchShape,
  stage: z.enum(returnStageSchema.options).optional().catch(undefined),
  connectionId: z.uuid().optional().catch(undefined),
  ...contextShape,
});

export type ReturnsSearch = z.infer<typeof returnsSearch>;

export const returnPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const returnGroupPageSize = 10;

const legacySorts: Readonly<
  Record<string, { sort: string; direction: 'asc' | 'desc' }>
> = {
  oldest: { sort: 'requested', direction: 'asc' },
  newest: { sort: 'requested', direction: 'desc' },
};

/** Whether the URL still uses filters or sort names of older links. */
export function hasLegacyFilters(search: ReturnsSearch) {
  return (
    search.stage !== undefined ||
    search.connectionId !== undefined ||
    (search.sort !== undefined && Object.hasOwn(legacySorts, search.sort))
  );
}

/**
 * Rewrites older filter keys into conditions, merged with the URL's own conditions, and the
 * older `oldest` and `newest` sorts into the request date, starting from the first page.
 */
export function withoutLegacyFilters(search: ReturnsSearch): ReturnsSearch {
  const conditions = legacyReturnConditions(search);
  const next: ReturnsSearch = { ...search };
  delete next.stage;
  delete next.connectionId;
  delete next.cursor;
  delete next.page;
  const sort = search.sort ? legacySorts[search.sort] : undefined;
  if (sort) {
    next.sort = sort.sort;
    next.direction = sort.direction;
  }

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: ReturnsSearch) {
  return Boolean(
    search.q || search.cursor || search.page || search.item || search.from,
  );
}

/** The list state without search, paging and page context, so the list starts on page one. */
export function returnFilters(search: ReturnsSearch): ReturnsSearch {
  const filters = { ...search };
  delete filters.q;
  delete filters.cursor;
  delete filters.page;
  delete filters.item;
  delete filters.from;

  return filters;
}

/** The list state a return page's breadcrumb returns to: the view and the page it was on. */
export function returnListSearch(search: ReturnsSearch): ReturnsSearch {
  return { ...returnFilters(search), cursor: search.cursor, page: search.page };
}

const views = new Set<string>(returnViewSchema.options);
const sorts = new Set<string>([
  'requested',
  'activity',
  'value',
  'pendingRefund',
  'stage',
]);

/**
 * Builds the list request for a view: its built-in segment, conditions (sent only when there
 * are any), sort and grouping, with the private search text and the page cursor. A view
 * without a sort uses its segment's (`segmentSort`). One "Stage is" condition goes as the
 * `stage` parameter, so the stage counts keep counting the other stages. Grouped reads return
 * each group's first rows and take no page cursor; `group` reads one group's next page.
 * Calendar conditions and date groups follow `timeZone`, the workspace's time zone.
 */
export function returnListQuery(
  state: CollectionViewState,
  search: { q: string; cursor?: string | undefined },
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): ReturnListQueryInput {
  const grouping = groupOf(state);
  const view =
    state.segment && views.has(state.segment)
      ? (state.segment as NonNullable<ReturnListQueryInput['view']>)
      : 'all';
  const sort = state.sort ?? segmentSort(view);
  const stage = chosenStage(state.where);
  const where = stage ? withStage(state.where, undefined) : state.where;

  return {
    q: search.q.trim(),
    view,
    ...(stage ? { stage } : {}),
    ...(where.conditions.length ? { where: JSON.stringify(where) } : {}),
    sort: sorts.has(sort.field)
      ? (sort.field as NonNullable<ReturnListQueryInput['sort']>)
      : 'requested',
    direction: sort.direction,
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: returnPageSize,
          }
        : { group: grouping, groupLimit: returnGroupPageSize }
      : { limit: returnPageSize, cursor: search.cursor }),
  };
}

/**
 * Maps a condition the list rejected ("Condition N" of the request's `where`) back to the
 * view's own conditions, which also hold the stage the request sends separately.
 */
export function viewConditionIndex(
  state: CollectionViewState,
  sentIndex: number | null,
): number | null {
  if (sentIndex === null || !chosenStage(state.where)) return sentIndex;
  const sent = state.where.conditions.flatMap((condition, index) =>
    condition.field === 'stage' ? [] : [index],
  );

  return sent[sentIndex] ?? null;
}

/** Loads a page of returns with counts per view and stage, or a grouped read. */
export function returnsOptions(
  organizationId: string,
  query: ReturnListQueryInput,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'returns', query],
    refetchOnReconnect: 'always',
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.returns.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Loads one return with its items, refunds, order and evidence. */
export function returnOptions(organizationId: string, returnId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'return', returnId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.returns.get({ params: { organizationId, returnId } }, { signal }),
  });
}

/** Loads only the per-view and per-stage counts and sources, for summaries such as Home. */
export function returnSummaryOptions(organizationId: string) {
  const query: ReturnListQueryInput = {
    q: '',
    view: 'all',
    sort: 'requested',
    direction: 'desc',
    limit: 1,
  };

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'returns', query],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.returns.list({ params: { organizationId }, query }, { signal }),
  });
}
