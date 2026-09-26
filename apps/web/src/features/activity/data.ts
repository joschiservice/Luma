import {
  activityOutcomes,
  activityPageSchema,
  type ActivityQuery,
  activityTypes,
} from '@luma/api-contract';
import {
  nextCalendarDay,
  workspaceDateValue,
  workspaceInstant,
} from '@luma/ui/lib/timezone';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

export interface ActivityFilters {
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  system?: ActivityQuery['system'];
  connectionId?: string | undefined;
  type?: ActivityQuery['type'];
  outcome?: ActivityQuery['outcome'];
  cursor?: string | undefined;
  event?: string | undefined;
  latest?: string | undefined;
}
const day = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v
    ? v
    : undefined;
const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

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
      typeof value.connectionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.connectionId,
      )
        ? value.connectionId
        : undefined,
    type: activityTypes.includes(value.type as ActivityQuery['type'] & string)
      ? (value.type as ActivityQuery['type'])
      : undefined,
    outcome: activityOutcomes.includes(
      value.outcome as ActivityQuery['outcome'] & string,
    )
      ? (value.outcome as ActivityQuery['outcome'])
      : undefined,
    cursor: text(value.cursor, 2048),
    event: text(value.event, 200),
    latest: text(value.latest, 200),
  };
}

/** Resolves the default 30 calendar days to an explicit workspace calendar range. */
export function activityRange(
  filters: ActivityFilters,
  now = new Date(),
  timeZone = 'UTC',
) {
  const to = filters.to ?? workspaceDateValue(now, timeZone);
  const from =
    filters.from ??
    new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);

  return { from, to };
}
const api = createWebApiClient();

/** Loads one bounded activity page; URL cursors retain browsing position across issue navigation. */
export function activityOptions(
  organizationId: string,
  filters: ActivityFilters,
  head = false,
  timeZone = 'UTC',
) {
  const range = activityRange(filters, new Date(), timeZone);
  const query = {
    ...filters,
    from: workspaceInstant(range.from, timeZone),
    to: workspaceInstant(nextCalendarDay(range.to), timeZone),
    limit: 30,
    cursor: head ? undefined : filters.cursor,
  };
  delete query.event;
  delete query.latest;

  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      head ? 'head' : 'page',
      query,
    ],
    ...privateQueryDefaults,
    refetchOnWindowFocus: head ? 'always' : false,
    refetchOnReconnect: 'always',
    refetchInterval: head ? 30_000 : false,
    queryFn: async ({ signal }) => {
      const result = await api.activity.list({
        params: { organizationId },
        query,
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) throw new IdentityError(result.status);

      return activityPageSchema.parse(result.body);
    },
  });
}
