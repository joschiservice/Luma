import type { WorkspaceTopic } from '@luma/api-contract';
import type { QueryClient } from '@tanstack/react-query';

import {
  changesAny,
  liveRefreshDelay,
  subscribeToWorkspaceMetrics,
} from '../../kit/live/metric-subscription';
import { insightsKey } from './data';

const chartTopics: readonly WorkspaceTopic[] = [
  'orders',
  'issues',
  'inventory',
  'procurement',
  'workflows',
  'connections',
];

/**
 * Refreshes charts at most once per `liveRefreshMs`, finishes active reads and limits failed
 * reads to one attempt per 30 seconds. Explicit refresh and filter changes remain immediate.
 */
export function subscribeToInsightChanges(
  organizationId: string,
  client: QueryClient,
) {
  let active = true;
  let busy = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastReadAt = -Infinity;

  const schedule = () => {
    dirty = true;
    if (!active || busy || timer) return;
    timer = setTimeout(() => void refresh(), liveRefreshDelay(lastReadAt));
  };
  const refresh = async () => {
    timer = undefined;
    dirty = false;
    busy = true;
    lastReadAt = Date.now();
    try {
      await client.invalidateQueries(
        {
          queryKey: insightsKey(organizationId),
          predicate: (query) =>
            !query.state.error ||
            Date.now() - query.state.errorUpdatedAt >= 30000,
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
      if (changesAny(event, chartTopics)) schedule();
    },
    onError: () => undefined,
  });

  return () => {
    active = false;
    clearTimeout(timer);
    stop();
  };
}
