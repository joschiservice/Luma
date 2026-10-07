import type {
  MetricRequest,
  MetricResponse,
  MetricSummaryResponse,
  OperationalMetricRequest,
  OperationalMetricResponse,
} from '@luma/api-contract';
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  changesAny,
  liveRefreshDelay,
  subscribeToWorkspaceMetrics,
} from './metric-subscription';
import {
  metricSummaryKey,
  metricSummaryOptions,
  partTopics,
  type SummaryPart,
} from './metric-summary-data';

export type LiveConnection =
  'connecting' | 'live' | 'syncing' | 'reconnecting' | 'offline' | 'denied';

/** A widget's read: its slice of the page's live summary, or a page of its own records. */
export interface LiveMetricRead<Response> {
  data: Response | undefined;
  error: Error | null;
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
  isPaused: boolean;
  refetch: () => void;
}

/** One widget's slice of the page's shared live read. */
export interface LiveMetricView<Response> extends LiveMetricRead<Response> {
  /** When the shared read last succeeded. Paging restarts after each live refresh. */
  updatedAt: number;
  connection: LiveConnection;
}

/**
 * The metric views a page can show. Leave out the ones the page does not render, and keep each
 * request stable between renders (a module constant or memoized value); a new request reads again.
 */
export interface LiveMetricRequests {
  operational?: OperationalMetricRequest | undefined;
  resolution?: OperationalMetricRequest | undefined;
  orders?: MetricRequest | undefined;
}

type PartName = keyof LiveMetricRequests;

/**
 * Keeps every metric widget on a page current with one request. Subscribes before loading,
 * serializes reads, refreshes when an area a widget reads changes, at most once per
 * `liveRefreshMs`, and at the earliest freshness boundary. A failed part affects only its widget.
 */
export function useLiveMetricSummary(
  organizationId: string,
  { operational, resolution, orders }: LiveMetricRequests,
): {
  operational: LiveMetricView<OperationalMetricResponse>;
  resolution: LiveMetricView<OperationalMetricResponse>;
  orders: LiveMetricView<MetricResponse>;
} {
  const client = useQueryClient();
  const included = useMemo(() => {
    const entries: { name: PartName; part: SummaryPart }[] = [];
    if (operational)
      entries.push({
        name: 'operational',
        part: { kind: 'operational', request: operational },
      });
    if (resolution)
      entries.push({
        name: 'resolution',
        part: { kind: 'operational', request: resolution },
      });
    if (orders)
      entries.push({
        name: 'orders',
        part: { kind: 'orders', request: orders },
      });

    return entries;
  }, [operational, resolution, orders]);
  const parts = useMemo(() => included.map(({ part }) => part), [included]);
  const [state, setState] = useState<{
    parts: SummaryPart[];
    ready: boolean;
    connection: LiveConnection;
  }>({ parts, ready: false, connection: 'connecting' });
  // A changed selection reads again before showing data.
  const current =
    state.parts === parts
      ? state
      : { parts, ready: false, connection: state.connection };
  const query = useQuery({
    ...metricSummaryOptions(organizationId, parts),
    enabled: current.ready && current.connection !== 'denied' && !!parts.length,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!parts.length) return;
    let active = true;
    let busy = false;
    let dirty = false;
    let loaded = false;
    let lastReadAt = -Infinity;
    let connected = false;
    let denied = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {
      /* Assigned when the stream opens below. */
    };
    const topics = [...new Set(parts.flatMap(partTopics))];
    const key = metricSummaryKey(organizationId);
    const update = (
      patch: Partial<{ ready: boolean; connection: LiveConnection }>,
    ) =>
      setState((previous) => ({
        ...(previous.parts === parts
          ? previous
          : { ready: false, connection: previous.connection }),
        ...patch,
        parts,
      }));
    const refresh = async () => {
      timer = undefined;
      if (busy || denied || !active) return;
      busy = true;
      dirty = false;
      lastReadAt = Date.now();
      try {
        if (!navigator.onLine) {
          update({ connection: 'offline' });

          return;
        }
        update({ connection: connected ? 'syncing' : 'reconnecting' });
        await client.cancelQueries({ queryKey: key });
        await client.invalidateQueries({ queryKey: key, refetchType: 'none' });
        await client.fetchQuery(metricSummaryOptions(organizationId, parts));
        loaded = true;
        if (active)
          update({
            ready: true,
            connection: connected ? 'live' : 'reconnecting',
          });
      } catch (error) {
        if (!active) return;
        denied =
          error instanceof IdentityError &&
          [401, 403, 404].includes(error.status);
        update({ ready: true, connection: denied ? 'denied' : 'reconnecting' });
        if (denied) {
          stop();
          client.removeQueries({ queryKey: key });
        }
      } finally {
        busy = false;
        if (dirty) schedule();
      }
    };
    // The first read and stream failures run at once; later changes are throttled.
    const schedule = (immediate = !loaded) => {
      dirty = true;
      if (!active || busy || denied) return;
      if (immediate) clearTimeout(timer);
      else if (timer) return;
      timer = setTimeout(
        () => void refresh(),
        immediate ? 0 : liveRefreshDelay(lastReadAt),
      );
    };
    stop = subscribeToWorkspaceMetrics(organizationId, {
      onResync: (event) => {
        if (!active) return;
        connected = event.connected;
        // Until the first read succeeds, any reconciliation loads the page.
        if (loaded ? changesAny(event, topics) : event.refetch) schedule();
        else if (!connected) update({ connection: 'reconnecting' });
      },
      onError: () => {
        if (!active) return;
        connected = false;
        update({ connection: navigator.onLine ? 'reconnecting' : 'offline' });
        schedule(true);
      },
    });

    return () => {
      active = false;
      clearTimeout(timer);
      stop();
      void client.cancelQueries({ queryKey: key });
    };
  }, [client, organizationId, parts]);

  useEffect(() => {
    if (
      query.isPlaceholderData ||
      !query.data?.nextRefreshAt ||
      current.connection === 'denied'
    )
      return;
    const delay = Math.max(
      1,
      Date.parse(query.data.nextRefreshAt) -
        Date.parse(query.data.readAt) -
        (Date.now() - query.dataUpdatedAt),
    );
    const timer = setTimeout(
      () =>
        void client.invalidateQueries({
          queryKey: metricSummaryOptions(organizationId, parts).queryKey,
          exact: true,
        }),
      Math.min(delay, 2147483647),
    );

    return () => clearTimeout(timer);
  }, [
    client,
    organizationId,
    parts,
    query.data?.nextRefreshAt,
    query.data?.readAt,
    query.dataUpdatedAt,
    query.isPlaceholderData,
    current.connection,
  ]);

  // Placeholder data comes from an earlier selection. A part is shown only from data read with
  // its current request; a changed request is pending until its own read arrives.
  const [dataFor, setDataFor] = useState(parts);
  if (query.data && !query.isPlaceholderData && dataFor !== parts)
    setDataFor(parts);
  const view = (name: PartName) => {
    const entry = included.find((candidate) => candidate.name === name);
    const index = entry
      ? dataFor.findIndex(
          (part) => JSON.stringify(part) === JSON.stringify(entry.part),
        )
      : -1;
    const part = index < 0 ? undefined : query.data?.parts[index];
    const failure =
      part && 'error' in part
        ? new IdentityError(part.status, part.error)
        : null;
    const error = query.error ?? failure;

    return {
      part,
      read: {
        error,
        isError: !!error,
        isPending: query.isPending || !part,
        isFetching: query.isFetching,
        isPaused: query.isPaused,
        refetch: () => void query.refetch(),
        updatedAt: query.dataUpdatedAt,
        connection:
          failure && [401, 403, 404].includes(failure.status)
            ? ('denied' as const)
            : current.connection,
      },
    };
  };
  const operationalData = (part: MetricSummaryResponse['parts'][number]) =>
    part && 'body' in part && part.kind === 'operational'
      ? part.body
      : undefined;
  const operationalView = view('operational');
  const resolutionView = view('resolution');
  const ordersView = view('orders');

  return {
    operational: {
      ...operationalView.read,
      data: operationalView.part
        ? operationalData(operationalView.part)
        : undefined,
    },
    resolution: {
      ...resolutionView.read,
      data: resolutionView.part
        ? operationalData(resolutionView.part)
        : undefined,
    },
    orders: {
      ...ordersView.read,
      data:
        ordersView.part &&
        'body' in ordersView.part &&
        ordersView.part.kind === 'orders'
          ? ordersView.part.body
          : undefined,
    },
  };
}

/**
 * Shows a widget's slice of the live summary, or a page of its matching records while the
 * person pages through them. A live refresh returns the widget to the first page.
 */
export function usePagedMetric<
  Request extends { snapshot?: string | undefined },
  Response,
>(
  live: LiveMetricView<Response>,
  initial: Request,
  options: (
    request: Request,
  ) => UseQueryOptions<Response, Error, Response, (string | Request)[]>,
): {
  query: LiveMetricRead<Response>;
  request: Request;
  setRequest: (request: Request) => void;
  connection: LiveConnection;
} {
  const [paging, setPaging] = useState<{
    request: Request;
    updatedAt: number;
  }>();
  const paged =
    paging?.request.snapshot && paging.updatedAt === live.updatedAt
      ? paging.request
      : undefined;
  const page = useQuery({
    ...options(paged ?? initial),
    enabled: !!paged && live.connection !== 'denied',
    placeholderData: (previous) => previous,
  });

  return {
    // The summary stays visible while the first requested page loads, as the next page does.
    query: paged
      ? {
          data: page.data ?? live.data,
          error: page.error,
          isError: page.isError,
          isPending: page.isPending && !live.data,
          isFetching: page.isFetching,
          isPaused: page.isPaused,
          refetch: () => void page.refetch(),
        }
      : live,
    request: paged ?? initial,
    setRequest: (request) =>
      setPaging(
        request.snapshot ? { request, updatedAt: live.updatedAt } : undefined,
      ),
    connection: live.connection,
  };
}
