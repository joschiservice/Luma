import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { subscribeToWorkspaceMetrics } from '../overview/metric-subscription';
import { decisionsKey } from './data';

export type DecisionUpdates = 'connecting' | 'live' | 'interrupted';

/**
 * Refetches Needs you reads when the workspace stream reports committed changes, including
 * decisions made on issues, workflow runs and records. Polling stays on as the fallback while
 * delivery is interrupted.
 */
export function useDecisionUpdates(organizationId: string): DecisionUpdates {
  const client = useQueryClient();
  const [state, setState] = useState<{
    organizationId: string;
    value: DecisionUpdates;
  }>({ organizationId, value: 'connecting' });

  useEffect(
    () =>
      subscribeToWorkspaceMetrics(organizationId, {
        onResync: (event) => {
          setState({
            organizationId,
            value: event.connected ? 'live' : 'interrupted',
          });
          if (event.refetch)
            void client.invalidateQueries({
              queryKey: decisionsKey(organizationId),
            });
        },
        onError: () => setState({ organizationId, value: 'interrupted' }),
      }),
    [client, organizationId],
  );

  return state.organizationId === organizationId ? state.value : 'connecting';
}

/** Re-renders on an interval so deadlines count down between reads. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
