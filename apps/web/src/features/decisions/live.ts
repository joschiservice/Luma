import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState } from 'react';

import {
  changesAny,
  subscribeToWorkspaceMetrics,
} from '../../kit/live/metric-subscription';
import { decisionsKey } from './data';

export type DecisionUpdates = 'connecting' | 'live' | 'interrupted';

/**
 * Refreshes Needs you reads when a queue source changes. Events from other areas are ignored.
 * Bursts coalesce into one refresh per short window and active reads finish first, so a busy
 * case or workflow does not repeat the queue read continuously. Explicit refreshes and the
 * person's own changes invalidate directly and stay immediate.
 */
export function subscribeToDecisionChanges(
  organizationId: string,
  client: QueryClient,
  onState: (state: Exclude<DecisionUpdates, 'connecting'>) => void,
) {
  let active = true;
  let busy = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    dirty = true;
    if (!active || busy || timer) return;
    timer = setTimeout(() => void refresh(), 500);
  };
  const refresh = async () => {
    timer = undefined;
    dirty = false;
    busy = true;
    try {
      await client.invalidateQueries(
        { queryKey: decisionsKey(organizationId) },
        { cancelRefetch: false },
      );
    } finally {
      busy = false;
      if (active && dirty) schedule();
    }
  };
  const stop = subscribeToWorkspaceMetrics(organizationId, {
    onResync: (event) => {
      onState(event.connected ? 'live' : 'interrupted');
      if (changesAny(event, ['decisions'])) schedule();
    },
    onError: () => onState('interrupted'),
  });

  return () => {
    active = false;
    clearTimeout(timer);
    stop();
  };
}

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
      subscribeToDecisionChanges(organizationId, client, (value) =>
        setState({ organizationId, value }),
      ),
    [client, organizationId],
  );

  return state.organizationId === organizationId ? state.value : 'connecting';
}

const DecisionUpdatesState = createContext<DecisionUpdates | undefined>(
  undefined,
);

/**
 * Shares the workspace shell's single Needs you subscription with the sidebar, Home and the
 * queue, so each screen stops polling while the stream is live without opening its own.
 */
export const DecisionUpdatesProvider = DecisionUpdatesState.Provider;

/**
 * The shell's Needs you stream state. Outside the shell it is unknown, and reads keep polling
 * through `decisionsRefresh`.
 */
export function useDecisionUpdatesState() {
  return useContext(DecisionUpdatesState);
}
