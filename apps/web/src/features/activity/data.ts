import {
  activityCatalog,
  type ActivityEvent,
  type ActivityExportRequest,
  activityOutcomes,
  type ActivityPage,
  type ActivityQuery,
  activityTypes,
  type CollectionCondition,
  type CollectionGranularity,
  type CollectionWhere,
  collectionWhereIssues,
} from '@luma/api-contract';
import {
  nextCalendarDay,
  workspaceDateValue,
  workspaceInstant,
} from '@luma/ui/lib/timezone';
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from '@tanstack/react-query';
import { z } from 'zod';

import { collectionSearchShape } from '../../kit/collections/state';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { activitySearchIssueClasses } from './presentation';

/** The recorded-time period a view keeps relative, such as the last 7 days. */
interface ActivityPeriod {
  amount: number;
  unit: CollectionGranularity;
}

type ActivityOutcome = ActivityEvent['outcome'];

/**
 * What the Activity list shows: its filters, which views keep as conditions, and the search and
 * open event, which stay in the URL only. Dates are workspace calendar days; `last` keeps a
 * relative period instead, so a saved "Last 7 days" stays the last 7 days.
 */
export interface ActivityFilters {
  from?: string | undefined;
  to?: string | undefined;
  last?: ActivityPeriod | undefined;
  q?: string | undefined;
  system?: ActivityQuery['system'];
  connectionId?: string | undefined;
  type?: ActivityQuery['type'];
  /** Outcomes, matching any. */
  outcome?: readonly ActivityOutcome[] | undefined;
  /** User IDs, `me`, `luma` or `workflow`. */
  actor?: readonly string[] | undefined;
  /** The event open in the preview. */
  event?: string | undefined;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string =>
  typeof v === 'string' &&
  dayPattern.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const day = (v: unknown) => (isDay(v) ? v : undefined);
const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.slice(0, max) : undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isOutcome = (value: unknown): value is ActivityOutcome =>
  activityOutcomes.includes(value as ActivityOutcome);

/** Keeps supported search fields and ignores malformed URL values. Dates are workspace calendar days. */
export function parseActivityFilters(
  value: Record<string, unknown>,
): ActivityFilters {
  const from = day(value.from),
    to = day(value.to);
  const valid =
    !from ||
    !to ||
    (from <= to && Date.parse(to) - Date.parse(from) < 366 * 86400000);

  return {
    from: valid ? from : undefined,
    to: valid ? to : undefined,
    q: text(value.q, 200),
    system: text(value.system, 100),
    connectionId:
      typeof value.connectionId === 'string' && uuid.test(value.connectionId)
        ? value.connectionId
        : undefined,
    type: activityTypes.includes(value.type as ActivityQuery['type'] & string)
      ? (value.type as ActivityQuery['type'])
      : undefined,
    outcome: isOutcome(value.outcome) ? [value.outcome] : undefined,
    event: text(value.event, 200),
  };
}

/** Filters older links put in the URL; the route turns them into the view's conditions. */
const legacyKeys = [
  'from',
  'to',
  'system',
  'connectionId',
  'type',
  'outcome',
] as const;

/**
 * URL state of the Activity page: the shared view keys, search text and the open event. Filters
 * of older links are accepted and rewritten into conditions by the route; their page cursors are
 * dropped, because the list loads older events below the newest instead of paging.
 */
export const activitySearch = z
  .object({
    ...collectionSearchShape,
    q: z.string().max(200).optional().catch(undefined),
    event: z.string().max(200).optional().catch(undefined),
    from: z.string().optional().catch(undefined),
    to: z.string().optional().catch(undefined),
    system: z.string().optional().catch(undefined),
    connectionId: z.string().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    outcome: z.string().optional().catch(undefined),
  })
  .catch({});

export type ActivitySearch = z.infer<typeof activitySearch>;

/** Whether the URL still uses filters of older links. */
export function hasLegacyActivityFilters(search: ActivitySearch) {
  return legacyKeys.some((key) => search[key] !== undefined);
}

/**
 * Rewrites the filters of older links, such as `?type=procurement`, into conditions merged with
 * the URL's own, and starts from the latest events.
 */
export function withoutLegacyActivityFilters(
  search: ActivitySearch,
): ActivitySearch {
  const legacy = parseActivityFilters(search);
  const next: ActivitySearch = { ...search };
  for (const key of legacyKeys) delete next[key];
  const conditions = activityConditions(legacy);
  if (!conditions.length) return next;
  const fields = new Set(conditions.map((condition) => condition.field));
  const current = (
    next.where?.match === 'any' && next.where.conditions.length > 1
      ? []
      : (next.where?.conditions ?? [])
  ).filter((condition) => !fields.has(condition.field));

  return {
    ...next,
    where: { match: 'all', conditions: [...current, ...conditions] },
  };
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesActivityState(search: ActivitySearch) {
  return Boolean(search.q || search.event);
}

/** Shifts a calendar day by whole days, weeks or months. */
function shiftDay(value: string, amount: number, unit: CollectionGranularity) {
  const date = new Date(`${value}T00:00:00Z`);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1));

  return date.toISOString().slice(0, 10);
}

/**
 * Expresses the filters as the view's conditions: the recorded time as a relative period or a
 * calendar range, one value for system, connection and type, and any outcomes and actors.
 */
export function activityConditions(
  filters: ActivityFilters,
): CollectionCondition[] {
  const conditions: CollectionCondition[] = [];
  if (filters.last)
    conditions.push({
      field: 'time',
      op: 'within_last',
      value: { amount: filters.last.amount, unit: filters.last.unit },
    });
  else if (filters.from || filters.to)
    conditions.push({
      field: 'time',
      op: 'between',
      value: { from: filters.from ?? null, to: filters.to ?? null },
    });
  const one = (field: string, value: string | undefined) => {
    if (value) conditions.push({ field, op: 'any_of', value: [value] });
  };
  one('system', filters.system);
  one('connection', filters.connectionId);
  one('type', filters.type);
  if (filters.outcome?.length)
    conditions.push({
      field: 'outcome',
      op: 'any_of',
      value: [...filters.outcome],
    });
  if (filters.actor?.length)
    conditions.push({
      field: 'actor',
      op: 'any_of',
      value: filters.actor.map((actor) =>
        actor === 'me' ? { dynamic: 'me' as const } : actor,
      ),
    });

  return conditions;
}

/** A condition Activity can't apply, with its position in the view's conditions. */
export interface ActivityIssue {
  index: number | null;
  message: string;
}

const single = (condition: CollectionCondition) =>
  condition.op === 'any_of' &&
  Array.isArray(condition.value) &&
  condition.value.length === 1 &&
  typeof condition.value[0] === 'string'
    ? condition.value[0]
    : undefined;

/**
 * Reads the view's conditions back into filters. Activity's API takes one value per filter,
 * except outcomes and actors, and a recorded-time period of at most 366 days, so anything else,
 * repeated fields and "match any" of several conditions are issues the page offers to remove.
 */
export function activityFiltersOf(
  where: CollectionWhere,
  today = new Date().toISOString().slice(0, 10),
): {
  filters: ActivityFilters;
  issues: ActivityIssue[];
} {
  const issues: ActivityIssue[] = collectionWhereIssues(activityCatalog, where);
  const broken = new Set(issues.map((issue) => issue.index));
  const filters: ActivityFilters = {};
  const seen = new Set<string>();
  if (where.match === 'any' && where.conditions.length > 1)
    issues.push({
      index: null,
      message: 'Activity can match all of its filters only',
    });
  where.conditions.forEach((condition, index) => {
    if (broken.has(index)) return;
    const problem = (message: string) => issues.push({ index, message });
    if (seen.has(condition.field))
      return problem('Activity takes one filter per field');
    seen.add(condition.field);
    switch (condition.field) {
      case 'time': {
        const value = condition.value;
        if (
          condition.op === 'within_last' &&
          value &&
          typeof value === 'object' &&
          'amount' in value &&
          'unit' in value
        ) {
          const start = shiftDay(today, -value.amount, value.unit);
          if (Date.parse(today) - Date.parse(start) >= 366 * 86400000)
            return problem('Choose a period of at most 366 days');
          filters.last = { amount: value.amount, unit: value.unit };

          return;
        }
        if (
          condition.op === 'between' &&
          value &&
          typeof value === 'object' &&
          'from' in value
        ) {
          const from = value.from === null ? undefined : day(value.from);
          const to = value.to === null ? undefined : day(value.to);
          if (
            (value.from !== null && !from) ||
            (value.to !== null && !to) ||
            (from &&
              to &&
              (from > to ||
                Date.parse(to) - Date.parse(from) >= 366 * 86400000))
          )
            return problem('Choose calendar days at most 366 days apart');
          filters.from = from;
          filters.to = to;

          return;
        }

        return problem('This filter is not supported');
      }
      case 'outcome': {
        const values = Array.isArray(condition.value) ? condition.value : [];
        if (
          condition.op !== 'any_of' ||
          !values.length ||
          !values.every(isOutcome)
        )
          return problem('Choose outcomes');
        filters.outcome = [...new Set(values)];

        return;
      }
      case 'system':
      case 'connection':
      case 'type': {
        const value = single(condition);
        if (!value) return problem('Choose one value');
        if (condition.field === 'system') filters.system = value;
        else if (condition.field === 'connection') {
          if (!uuid.test(value)) return problem('Choose a connection');
          filters.connectionId = value;
        } else filters.type = value as ActivityFilters['type'];

        return;
      }
      case 'actor': {
        const values = Array.isArray(condition.value) ? condition.value : [];
        const actors = values.flatMap((value) =>
          typeof value === 'object' && value && 'dynamic' in value
            ? value.dynamic === 'me'
              ? ['me']
              : []
            : typeof value === 'string' &&
                (value === 'luma' || value === 'workflow' || uuid.test(value))
              ? [value]
              : [],
        );
        if (
          condition.op !== 'any_of' ||
          !actors.length ||
          actors.length !== values.length ||
          actors.length > 20
        )
          return problem('Choose people, Luma or workflows');
        filters.actor = actors;

        return;
      }
      default:
        return problem('This filter is not supported');
    }
  });

  return { filters, issues };
}

/** The 30 calendar days the list shows without a recorded-time filter. */
const defaultDays = 30;

/**
 * Resolves the recorded-time filter to an explicit workspace calendar range: a relative period
 * ends today, a range missing its start covers 30 days and one missing its end runs to today.
 */
export function activityRange(
  filters: ActivityFilters,
  now = new Date(),
  timeZone = 'UTC',
) {
  const today = workspaceDateValue(now, timeZone);
  if (filters.last)
    return {
      from: shiftDay(today, -filters.last.amount, filters.last.unit),
      to: today,
    };
  const to = filters.to ?? today;
  const from =
    filters.from ??
    new Date(Date.parse(to) - (defaultDays - 1) * 86400000)
      .toISOString()
      .slice(0, 10);

  return { from, to };
}

const api = createWebApiClient();

/** Events per read: the list's first screen and each "Show older events". */
const activityPageSize = 30;

/**
 * The filters as API parameters, with the recorded time resolved to workspace days. Search also
 * names the issue kinds whose names, in the reader's language, contain the search text.
 */
function activityFilterQuery(filters: ActivityFilters, timeZone: string) {
  const range = activityRange(filters, new Date(), timeZone);
  const classes = filters.q ? activitySearchIssueClasses(filters.q) : [];

  return {
    from: workspaceInstant(range.from, timeZone),
    to: workspaceInstant(nextCalendarDay(range.to), timeZone),
    ...(filters.q ? { q: filters.q } : {}),
    ...(classes.length ? { searchIssueClasses: classes.join(',') } : {}),
    ...(filters.system ? { system: filters.system } : {}),
    ...(filters.connectionId ? { connectionId: filters.connectionId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.outcome?.length
      ? { outcome: [...filters.outcome].sort().join(',') }
      : {}),
    ...(filters.actor?.length ? { actor: filters.actor.join(',') } : {}),
  };
}

/** The business-view request for the filters, without page position. */
function activityQuery(
  filters: ActivityFilters,
  detail: 'summary' | 'steps',
  timeZone: string,
) {
  return {
    view: 'business' as const,
    detail,
    ...activityFilterQuery(filters, timeZone),
    limit: activityPageSize,
  };
}

/**
 * Reads the newest events without their steps. Home lists them, and the Activity page polls it
 * every 30 seconds and on focus to offer new events without moving the list being read.
 */
export function activityHeadOptions(
  organizationId: string,
  filters: ActivityFilters,
  timeZone = 'UTC',
) {
  const query = activityQuery(filters, 'summary', timeZone);

  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      'head',
      query,
    ],
    ...privateQueryDefaults,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      api.activity.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Reads the Activity list with each event's earlier steps, newest first; each further page
 * continues from the previous page's cursor, so older events append below the ones being read.
 * A refetch reads every loaded page again from the newest.
 */
export function activityFeedOptions(
  organizationId: string,
  filters: ActivityFilters,
  timeZone = 'UTC',
) {
  const query = activityQuery(filters, 'steps', timeZone);

  return infiniteQueryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      'feed',
      query,
    ],
    ...privateQueryDefaults,
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ActivityPage) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }): Promise<ActivityPage> =>
      api.activity.list(
        {
          params: { organizationId },
          query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) },
        },
        { signal },
      ),
  });
}

/**
 * Reads the group holding one event with its steps, under the list's filters, for an event a
 * link opened that the loaded list doesn't hold. An empty page means the filters exclude it.
 */
export function activityEventOptions(
  organizationId: string,
  filters: ActivityFilters,
  event: string,
  timeZone = 'UTC',
) {
  const query = { ...activityQuery(filters, 'steps', timeZone), event };

  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      'event',
      query,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.activity.list({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Counts the groups each quick view would list under the filters, without the outcome filter.
 * `latest` is the newest event the page knows of, so the counts follow new events.
 */
export function activityCountsOptions(
  organizationId: string,
  filters: ActivityFilters,
  latest: string | undefined,
  timeZone = 'UTC',
) {
  const query = activityFilterQuery(
    { ...filters, outcome: undefined },
    timeZone,
  );

  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      'counts',
      query,
      latest ?? null,
    ],
    ...privateQueryDefaults,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      api.activity.counts({ params: { organizationId }, query }, { signal }),
  });
}

/**
 * Exports every recorded event that matches the filters as CSV, with headings and names for
 * recorded codes in the reader's language. The API checks export permission, caps the rows and
 * records the export in the audit log.
 */
export function exportActivity(
  organizationId: string,
  filters: ActivityFilters,
  labels: Omit<ActivityExportRequest, 'query'>,
  timeZone = 'UTC',
) {
  return api.activity.export({
    params: { organizationId },
    body: { query: activityFilterQuery(filters, timeZone), ...labels },
  });
}
