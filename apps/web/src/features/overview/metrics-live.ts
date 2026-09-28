import type { MetricRequest, MetricResponse } from '@luma/api-contract';
import { subscribeToMetrics } from '@luma/api-contract/client';
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { IdentityError } from '../identity/data';
import { metricsOptions } from './metrics-data';

/** Subscribes before loading, serializes refreshes, and replaces paginated snapshots on changes. */
export function useLiveMetricQuery<
  Request,
  Response extends {
    nextRefreshAt?: string | null | undefined;
    readAt: string;
  },
>(
  organizationId: string,
  config: {
    initial: Request;
    key: string;
    options: (
      organizationId: string,
      request: Request,
    ) => UseQueryOptions<Response, Error, Response, (string | Request)[]>;
  },
) {
  const client = useQueryClient();
  const [request, setRequest] = useState<Request>(config.initial);
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState('connecting');
  const [attempt, setAttempt] = useState(0);
  const query = useQuery({
    ...config.options(organizationId, request),
    enabled: ready && connection !== 'denied',
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    let active = true;
    let busy = false;
    let dirty = false;
    let connected = false;
    let denied = false;
    let lastEventAt = Date.now();
    let lastFallbackAt = Date.now();
    let stop = () => {
      /* Assigned when the stream opens below. */
    };
    const key = ['private', 'organization', organizationId, config.key];
    const refresh = async () => {
      dirty = true;
      if (busy || denied) return;
      busy = true;
      while (dirty && active && !denied) {
        dirty = false;
        if (!navigator.onLine) {
          setConnection('offline');
          break;
        }
        setConnection(connected ? 'syncing' : 'reconnecting');
        setRequest(config.initial);
        try {
          await client.cancelQueries({ queryKey: key });
          await client.invalidateQueries({
            queryKey: key,
            refetchType: 'none',
          });
          await client.fetchQuery(
            config.options(organizationId, config.initial),
          );
          if (active) {
            setReady(true);
            setConnection(connected ? 'live' : 'reconnecting');
          }
        } catch (error) {
          if (!active) break;
          denied =
            error instanceof IdentityError &&
            [401, 403, 404].includes(error.status);
          setReady(true);
          setConnection(denied ? 'denied' : 'reconnecting');
          if (denied) {
            stop();
            client.removeQueries({ queryKey: key });
          }
        }
      }
      busy = false;
    };
    stop = subscribeToMetrics({
      baseUrl: '/api',
      organizationId,
      onResync: (event) => {
        if (!active) return;
        lastEventAt = Date.now();
        connected = event.connected;
        if (event.refetch) void refresh();
        else if (!connected) setConnection('reconnecting');
      },
      onError: () => {
        if (!active) return;
        connected = false;
        setConnection(navigator.onLine ? 'reconnecting' : 'offline');
        void refresh();
      },
    });
    const recover = () => setAttempt((value) => value + 1);
    const offline = () => {
      connected = false;
      setConnection('offline');
    };
    window.addEventListener('online', recover);
    window.addEventListener('offline', offline);
    // Covers a proxy silently dropping the stream, and failures before the first event.
    const fallback = setInterval(() => {
      if (denied) return;
      if (Date.now() - lastEventAt > 12000) {
        connected = false;
        setConnection(navigator.onLine ? 'reconnecting' : 'offline');
      }
      if (!connected && Date.now() - lastFallbackAt >= 30000) {
        lastFallbackAt = Date.now();
        void refresh();
      }
    }, 5000);

    return () => {
      active = false;
      stop();
      clearInterval(fallback);
      window.removeEventListener('online', recover);
      window.removeEventListener('offline', offline);
      void client.cancelQueries({ queryKey: key });
    };
  }, [client, organizationId, attempt, config]);

  useEffect(() => {
    if (
      query.isPlaceholderData ||
      !query.data?.nextRefreshAt ||
      connection === 'denied'
    )
      return;
    const delay = Math.max(
      1,
      Date.parse(query.data.nextRefreshAt) -
        Date.parse(query.data.readAt) -
        (Date.now() - query.dataUpdatedAt),
    );
    const timer = setTimeout(
      () => {
        setRequest(config.initial);
        void client.invalidateQueries({
          queryKey: config.options(organizationId, config.initial).queryKey,
          exact: true,
        });
      },
      Math.min(delay, 2147483647),
    );

    return () => clearTimeout(timer);
  }, [
    client,
    config,
    organizationId,
    query.data?.nextRefreshAt,
    query.data?.readAt,
    query.dataUpdatedAt,
    query.isPlaceholderData,
    connection,
  ]);

  return { query, request, setRequest, connection };
}

const orderConfig = {
  initial: {} as MetricRequest,
  key: 'order-metrics',
  options: metricsOptions,
};

/** Keeps order v1 counts and cohorts current through the shared metric stream. */
export function useLiveMetrics(organizationId: string) {
  return useLiveMetricQuery<MetricRequest, MetricResponse>(
    organizationId,
    orderConfig,
  );
}
