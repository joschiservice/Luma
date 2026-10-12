import { subscribeToCaseProgress } from '@luma/api-contract/client';
import type { LiveConnection } from '@luma/ui/components/issues/case-timeline';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { IdentityError } from '../../kit/identity/data';
import { casesKey } from './data';
import { historyOptions, observationOptions } from './observation-data';

/** Shared current case state, history, and refresh controls for a selected investigation. */
export type CaseObservation = ReturnType<typeof useCaseObservation>;

/**
 * Owns selected-case freshness and stream recovery. History failures do not block current
 * decisions; denied reads hide the case. An empty selection opens no stream or reads.
 */
export function useCaseObservation(
  organizationId: string,
  exceptionId: string,
) {
  const client = useQueryClient();
  const scope = `${organizationId}:${exceptionId}`;
  const [pagination, setPagination] = useState({ scope, pages: 1 });
  const pages = pagination.scope === scope ? pagination.pages : 1;
  const [stream, setStream] = useState<{
    scope: string;
    state: LiveConnection;
  }>({
    scope,
    state: 'connecting',
  });
  const [offline, setOffline] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const connection = stream.scope === scope ? stream.state : 'connecting';
  const interval =
    connection === 'live' || connection === 'syncing' ? false : 5000;
  const snapshot = useQuery({
    ...observationOptions(organizationId, exceptionId),
    refetchInterval: interval,
  });
  const history = useQuery({
    ...historyOptions(organizationId, exceptionId, pages),
    refetchInterval: interval,
  });
  const refresh = useCallback(async () => {
    // Inbox refreshes must not determine whether the selected case is confirmed.
    void client.invalidateQueries(
      {
        queryKey: casesKey(organizationId),
        predicate: (query) =>
          !['observation', 'history'].includes(String(query.queryKey[4])),
      },
      { cancelRefetch: false },
    );
    void client.invalidateQueries(
      {
        queryKey: [...casesKey(organizationId), 'history', exceptionId],
      },
      { cancelRefetch: false },
    );
    await client.invalidateQueries(
      {
        queryKey: observationOptions(organizationId, exceptionId).queryKey,
        exact: true,
      },
      { throwOnError: true, cancelRefetch: false },
    );
  }, [client, organizationId, exceptionId]);

  useEffect(() => {
    const onOffline = () => {
      setOffline(true);
      setStream((previous) => ({ ...previous, state: 'disconnected' }));
    };
    const onOnline = () => {
      setOffline(false);
      setStream((previous) => ({ ...previous, state: 'connecting' }));
      setStreamAttempt((attempt) => attempt + 1);
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (!navigator.onLine) onOffline();

    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    if (!exceptionId || offline) return;
    let active = true;
    let generation = 0;
    const update = (state: LiveConnection) => setStream({ scope, state });
    const close = subscribeToCaseProgress({
      baseUrl: '/api',
      organizationId,
      exceptionId,
      onResync: () => {
        if (!active) return;
        const current = ++generation;
        update('syncing');
        void refresh()
          .then(() => {
            if (active && generation === current) update('live');
          })
          .catch(() => {
            if (active && generation === current) update('disconnected');
          });
      },
      onError: () => {
        generation++;
        if (!active) return;
        update('disconnected');
        // Stream failure may mean revoked access; confirm through authenticated reads.
        void refresh().catch(() => {
          /* Query state presents refresh failures. */
        });
      },
    });

    return () => {
      active = false;
      generation++;
      close();
    };
  }, [organizationId, exceptionId, scope, streamAttempt, refresh, offline]);

  const denied = [snapshot.error, history.error].some(
    (error) =>
      error instanceof IdentityError && [401, 403, 404].includes(error.status),
  );
  const confirmed =
    !denied &&
    !offline &&
    !snapshot.isPaused &&
    !snapshot.isError &&
    Boolean(snapshot.data);

  const liveConnection: LiveConnection = !confirmed
    ? 'disconnected'
    : connection === 'disconnected'
      ? 'interrupted'
      : connection;

  return {
    organizationId,
    snapshot,
    history,
    denied,
    offline,
    confirmed,
    connection: liveConnection,
    refresh,
    restart: () => {
      setStreamAttempt((attempt) => attempt + 1);
      void refresh().catch(() => {
        /* Query state presents refresh failures. */
      });
    },
    retryHistory: () => {
      void history.refetch();
    },
    loadMore: () => setPagination({ scope, pages: pages + 1 }),
  };
}
