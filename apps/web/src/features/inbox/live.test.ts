import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { subscribeToWorkspaceMetrics } from '../../kit/live/metric-subscription';
import { messagingKey } from './data';
import { subscribeToMessagingChanges } from './live';

vi.mock('../../kit/live/metric-subscription', async (original) => ({
  ...(await original<typeof import('../../kit/live/metric-subscription')>()),
  subscribeToWorkspaceMetrics: vi.fn(() => vi.fn()),
}));

const stream = vi.mocked(subscribeToWorkspaceMetrics);
let client: QueryClient;
const cleanup: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  stream.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  client.clear();
  vi.useRealTimers();
});

function change(topics: string[]) {
  stream.mock.calls[0]![1].onResync({
    schemaVersion: 1,
    organizationId: 'workspace',
    scope: 'order-metrics',
    connected: true,
    refetch: true,
    topics,
    sentAt: new Date().toISOString(),
  });
}

it('refreshes inbox reads once per burst of messaging changes and ignores other areas', async () => {
  const read = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  const observer = new QueryObserver(client, {
    queryKey: [...messagingKey('workspace'), 'threads'],
    queryFn: read,
  });
  cleanup.push(observer.subscribe(() => undefined));
  await vi.advanceTimersByTimeAsync(0);
  const states: string[] = [];
  cleanup.push(
    subscribeToMessagingChanges('workspace', client, (state) =>
      states.push(state),
    ),
  );
  read.mockClear();

  change(['orders']);
  await vi.advanceTimersByTimeAsync(600);
  expect(read).not.toHaveBeenCalled();

  change(['messaging']);
  change(['messaging', 'decisions']);
  await vi.advanceTimersByTimeAsync(600);
  expect(read).toHaveBeenCalledTimes(1);
  expect(states).toContain('live');
});
