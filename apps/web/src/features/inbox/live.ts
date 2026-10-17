import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  changesAny,
  subscribeToWorkspaceMetrics,
} from '../../kit/live/metric-subscription';
import { messagingKey } from './data';

export type InboxUpdates = 'connecting' | 'live' | 'interrupted';

// Decisions elsewhere in the workspace reach the inbox only through reply approvals, which
// change thread lists, their counts and open threads, not mailboxes, documents or record lists.
const approvalReads = new Set(['threads', 'thread']);

/**
 * Refreshes messaging reads when the workspace stream reports a committed change. Messaging
 * changes refresh every active inbox read; decision changes refresh only thread lists and open
 * threads. Bursts coalesce into one refresh per short window and active reads finish first, so a
 * mailbox import does not repeat every read continuously.
 */
export function subscribeToMessagingChanges(
  organizationId: string,
  client: QueryClient,
  onState: (state: Exclude<InboxUpdates, 'connecting'>) => void,
) {
  let active = true;
  let busy = false;
  let dirty = false;
  let messaging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    dirty = true;
    if (!active || busy || timer) return;
    timer = setTimeout(() => void refresh(), 500);
  };
  const refresh = async () => {
    timer = undefined;
    dirty = false;
    const all = messaging;
    messaging = false;
    busy = true;
    try {
      await client.invalidateQueries(
        {
          queryKey: messagingKey(organizationId),
          ...(all
            ? {}
            : {
                predicate: (query) =>
                  approvalReads.has(String(query.queryKey[4])),
              }),
        },
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
      if (changesAny(event, ['messaging'])) messaging = true;
      // Replies and their approvals also carry the `decisions` topic.
      if (changesAny(event, ['messaging', 'decisions'])) schedule();
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
 * Keeps inbox reads current from the workspace change stream. Pass the returned state to the
 * read options, which poll only while the stream is not live, so reads still converge while it
 * is interrupted.
 */
export function useInboxUpdates(organizationId: string): InboxUpdates {
  const client = useQueryClient();
  const [state, setState] = useState<{
    organizationId: string;
    value: InboxUpdates;
  }>({ organizationId, value: 'connecting' });

  useEffect(
    () =>
      subscribeToMessagingChanges(organizationId, client, (value) =>
        setState({ organizationId, value }),
      ),
    [client, organizationId],
  );

  return state.organizationId === organizationId ? state.value : 'connecting';
}
