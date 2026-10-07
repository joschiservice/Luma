import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { subscribeToWorkspaceMetrics } from '../overview/metric-subscription';
import { decisionsKey } from './data';
import { subscribeToDecisionChanges } from './live';

vi.mock('../overview/metric-subscription', async (original) => ({
  ...(await original<typeof import('../overview/metric-subscription')>()),
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

function change(topics = ['decisions'], connected = true) {
  stream.mock.calls[0]![1].onResync({
    schemaVersion: 1,
    organizationId: 'workspace',
    scope: 'order-metrics',
    connected,
    refetch: true,
    topics,
    sentAt: new Date().toISOString(),
  });
}

function observe(limit: number, read: () => Promise<number>) {
  const observer = new QueryObserver(client, {
    queryKey: [...decisionsKey('workspace'), { view: 'all', limit }],
    queryFn: read,
  });
  cleanup.push(observer.subscribe(() => undefined));

  return observer;
}

it('refreshes the queue and navigation count once per burst of workspace changes', async () => {
  const count = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  const page = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  observe(1, count);
  observe(25, page);
  await vi.advanceTimersByTimeAsync(0);
  const states: string[] = [];
  cleanup.push(
    subscribeToDecisionChanges('workspace', client, (state) =>
      states.push(state),
    ),
  );

  for (let index = 0; index < 40; index++) {
    change();
    await vi.advanceTimersByTimeAsync(10);
  }
  await vi.advanceTimersByTimeAsync(500);

  expect(count).toHaveBeenCalledTimes(2);
  expect(page).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toBe('live');
});

it('ignores changes outside the queue sources', async () => {
  const count = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  observe(1, count);
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(subscribeToDecisionChanges('workspace', client, vi.fn()));

  for (let index = 0; index < 20; index++)
    change(['connections', 'orders', 'inventory']);
  await vi.advanceTimersByTimeAsync(10000);

  expect(count).toHaveBeenCalledOnce();
});

it('lets an active read finish and follows changes made during it', async () => {
  const count = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  const observer = observe(1, count);
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(subscribeToDecisionChanges('workspace', client, vi.fn()));
  let finish: (value: number) => void = () => undefined;
  count.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );

  change();
  await vi.advanceTimersByTimeAsync(500);
  for (let index = 0; index < 20; index++) change();
  await vi.advanceTimersByTimeAsync(10000);
  expect(count).toHaveBeenCalledTimes(2);

  finish(3);
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toBe(3);
  await vi.advanceTimersByTimeAsync(500);
  expect(count).toHaveBeenCalledTimes(3);
});

it('reports interrupted delivery and drops queued refreshes when the page closes', async () => {
  const count = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  observe(1, count);
  await vi.advanceTimersByTimeAsync(0);
  const states: string[] = [];
  const stop = subscribeToDecisionChanges('workspace', client, (state) =>
    states.push(state),
  );

  change(['decisions'], false);
  stream.mock.calls[0]![1].onError();
  stop();
  await vi.advanceTimersByTimeAsync(30000);

  expect(states).toEqual(['interrupted', 'interrupted']);
  expect(count).toHaveBeenCalledOnce();
  expect(stream.mock.results[0]!.value).toHaveBeenCalledOnce();
});
