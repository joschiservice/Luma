import {
  caseClasses,
  type CaseQuery,
  type caseQuerySchema,
  caseStates,
  type CaseSummary,
  type CollectionCondition,
  type CollectionGroup,
  type CollectionViewState,
  type CollectionWhere,
} from '@luma/api-contract';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { anyOf, withLegacyConditions } from '../../kit/collections/legacy';
import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

/** The list request as the API client accepts it. */
export type CaseListQueryInput = z.input<typeof caseQuerySchema>;

/**
 * URL state of the issue list and the issue open beside it: the shared list keys (view,
 * conditions, sort, grouping, display and paging), the workflow to show and filters of older
 * links. Search can match record IDs, so `q` only arrives with links and the page moves it into
 * page state. Older links name an owner (or `unassigned`), a type, a severity or a state; the
 * route turns them into conditions.
 */
export const inboxSearch = z.object({
  ...collectionSearchShape,
  shadow: z.string().min(1).max(200).optional().catch(undefined),
  ownerId: z
    .union([z.string().uuid(), z.literal('unassigned')])
    .optional()
    .catch(undefined),
  class: z.enum(caseClasses).optional().catch(undefined),
  severity: z.enum(['high', 'medium']).optional().catch(undefined),
  state: z.enum(caseStates).optional().catch(undefined),
});

export type InboxSearch = z.infer<typeof inboxSearch>;

type CaseView = CaseQuery['view'];

const caseViews: readonly CaseView[] = ['needs_you', 'active', 'history'];

/** The case list a view value names; missing or unknown segments show All open. */
export function caseView(value: string | null | undefined): CaseView {
  return caseViews.find((view) => view === value) ?? 'active';
}

/** Whether the URL still uses the filters of older links. */
export function hasLegacyFilters(search: InboxSearch) {
  return Boolean(
    search.ownerId || search.class || search.severity || search.state,
  );
}

/** Converts the filters older links use into conditions that select the same issues. */
function legacyCaseConditions(
  search: Pick<InboxSearch, 'ownerId' | 'class' | 'severity' | 'state'>,
): CollectionCondition[] {
  const conditions: CollectionCondition[] = [];
  if (search.ownerId === 'unassigned')
    conditions.push({ field: 'owner', op: 'empty' });
  else if (search.ownerId) conditions.push(anyOf('owner', search.ownerId));
  if (search.class) conditions.push(anyOf('class', search.class));
  if (search.severity) conditions.push(anyOf('severity', search.severity));
  if (search.state) conditions.push(anyOf('state', search.state));

  return conditions;
}

/**
 * Rewrites the filters of older links, such as Insights' link to one issue type, into
 * conditions merged with the URL's own, starting from the first page.
 */
export function withoutLegacyFilters(search: InboxSearch): InboxSearch {
  const conditions = legacyCaseConditions(search);
  const next: InboxSearch = { ...search };
  delete next.ownerId;
  delete next.class;
  delete next.severity;
  delete next.state;
  delete next.cursor;
  delete next.page;

  return conditions.length
    ? { ...next, where: withLegacyConditions(search.where, conditions) }
    : next;
}

/** Whether the URL names page context, so the route must not restore a remembered view. */
export function namesListState(search: InboxSearch) {
  return Boolean(search.q || search.cursor || search.page || search.shadow);
}

/** The list state without search and paging, so the list starts on page one. */
export function caseFilters(search: InboxSearch): InboxSearch {
  const filters = { ...search };
  delete filters.q;
  delete filters.cursor;
  delete filters.page;

  return filters;
}

/** The urgency order the list uses when a view names no sort. */
export const defaultCaseSort = {
  field: 'urgency',
  direction: 'asc',
} as const;

const sorts = new Set<string>([
  'urgency',
  'detected',
  'lastActivity',
  'waitingSince',
]);

export const casePageSize = 25;

/** Rows each group shows before "Show more", and the size of each further page. */
const caseGroupPageSize = 10;

/**
 * Builds the list request for a view: its built-in view, conditions (sent only when there are
 * any), sort and grouping, with the private search text and the page cursor. Grouped reads
 * return each group's first rows and take no page cursor; `group` reads one group's next page.
 * Calendar conditions follow `timeZone`, the workspace's time zone.
 */
export function caseListQuery(
  state: CollectionViewState,
  search: { q: string; cursor?: string | undefined },
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): CaseListQueryInput {
  const grouping = groupOf(state);
  const sort = state.sort ?? defaultCaseSort;

  return {
    view: caseView(state.segment),
    q: search.q.trim(),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort: sorts.has(sort.field)
      ? (sort.field as NonNullable<CaseListQueryInput['sort']>)
      : 'urgency',
    direction: sort.direction,
    timeZone,
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: casePageSize,
          }
        : { group: grouping, groupLimit: caseGroupPageSize }
      : { limit: casePageSize, cursor: search.cursor }),
  };
}

const api = createWebApiClient();

/** Returns the query-key prefix for all case data in one organization. */
export const casesKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'cases'] as const;

const options = {
  ...privateQueryDefaults,
  refetchOnWindowFocus: 'always',
} as const;

/** Loads a validated page of issues, or every group's first issues of a grouped read. */
export function casesOptions(
  organizationId: string,
  query: CaseListQueryInput,
) {
  const request: CaseListQueryInput = { limit: casePageSize, ...query };

  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'list', request],
    // A changed filter keeps the previous rows visible until the new ones arrive.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.exceptions.list(
        { params: { organizationId }, query: request },
        { signal },
      ),
  });
}

/**
 * Loads a validated case detail; rejects invalid IDs and disables fetching for an empty
 * selection.
 */
export function caseOptions(organizationId: string, exceptionId: string) {
  return queryOptions({
    ...options,
    queryKey: [...casesKey(organizationId), 'detail', exceptionId],
    enabled: Boolean(exceptionId),
    queryFn: async ({ signal }) => {
      if (!z.uuid().safeParse(exceptionId).success)
        throw new IdentityError(404);

      return api.exceptions.get(
        { params: { organizationId, exceptionId } },
        { signal },
      );
    },
  });
}

/** The value of one issue for a condition the client can check without the server. */
const readers: Readonly<
  Record<string, (item: CaseSummary) => readonly string[] | string | null>
> = {
  class: (item) => item.class,
  state: (item) => item.state,
  severity: (item) => item.severity,
  subjectType: (item) => item.subject.kind,
  attention: (item) => item.attention.reason,
  freshness: (item) => item.freshness,
  diagnosis: (item) => item.diagnosisStatus,
  resolution: (item) => item.resolution,
  source: (item) => item.sources,
};

/** Whether an issue satisfies a condition; conditions the client can't check count as met. */
function satisfies(item: CaseSummary, condition: CollectionCondition) {
  const read = Object.hasOwn(readers, condition.field)
    ? readers[condition.field]
    : undefined;
  if (!read) return true;
  const value = read(item);
  const present = Array.isArray(value) ? value : value === null ? [] : [value];
  const chosen = Array.isArray(condition.value)
    ? condition.value.filter((entry) => typeof entry === 'string')
    : [];
  if (condition.op === 'empty') return present.length === 0;
  if (condition.op === 'not_empty') return present.length > 0;
  if (condition.op === 'any_of')
    return present.some((entry) => chosen.includes(entry));
  if (condition.op === 'none_of')
    return !present.some((entry) => chosen.includes(entry));
  if (condition.op === 'all_of')
    return chosen.every((entry) => present.includes(entry));

  return true;
}

/**
 * Checks whether an open issue still belongs in the view: its built-in view and the conditions
 * the client can check from the issue itself. Owner and date conditions are left to the list.
 */
export function matchesView(
  item: CaseSummary,
  view: { segment: string | null; where: CollectionWhere },
) {
  const segment = caseView(view.segment);
  const inView =
    segment === 'needs_you'
      ? item.attention.required
      : segment === 'history'
        ? item.state === 'resolved'
        : item.state !== 'resolved';
  const results = view.where.conditions.map((condition) =>
    satisfies(item, condition),
  );

  return (
    inView &&
    (!results.length ||
      (view.where.match === 'any'
        ? results.some(Boolean)
        : results.every(Boolean)))
  );
}
