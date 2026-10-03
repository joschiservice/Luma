import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { subscribeToWorkspaceMetrics } from '../overview/metric-subscription';
import { insightsKey } from './data';
import { subscribeToInsightChanges } from './live';

vi.mock('../overview/metric-subscription', () => ({
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

function change() {
  stream.mock.calls[0]![1].onResync({
    schemaVersion: 1,
    organizationId: 'workspace',
    scope: 'order-metrics',
    connected: true,
    refetch: true,
    sentAt: new Date().toISOString(),
  });
}

function observe(read: () => Promise<number>, organizationId = 'workspace') {
  const observer = new QueryObserver(client, {
    queryKey: [...insightsKey(organizationId), 'orders'],
    queryFn: read,
  });
  cleanup.push(observer.subscribe(() => undefined));

  return observer;
}

it('coalesces import events without cancelling active reads and follows changes during a read', async () => {
  const read = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  const observer = observe(read);
  const other = vi.fn<() => Promise<number>>().mockResolvedValue(2);
  observe(other, 'other');
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(subscribeToInsightChanges('workspace', client));
  for (let index = 0; index < 30; index++) change();
  let finish: (value: number) => void = () => undefined;
  read.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(observer.getCurrentResult().data).toBe(1);
  for (let index = 0; index < 30; index++) change();
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  finish(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(other).toHaveBeenCalledOnce();
});

it('keeps a failed chart stable through repeated events, allows manual retry and recovers later', async () => {
  const read = vi.fn<() => Promise<number>>().mockRejectedValue(
    Object.assign(new Error('Order history is being prepared'), {
      status: 503,
    }),
  );
  const observer = observe(read);
  await vi.advanceTimersByTimeAsync(0);
  cleanup.push(subscribeToInsightChanges('workspace', client));
  for (let index = 0; index < 30; index++) {
    change();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(read).toHaveBeenCalledOnce();
  expect(observer.getCurrentResult()).toMatchObject({
    isError: true,
    isFetching: false,
  });
  await observer.refetch();
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30000);
  read.mockResolvedValue(4);
  change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(observer.getCurrentResult().data).toBe(4);
});

it('drops queued refreshes when the charts leave the page', async () => {
  const read = vi.fn<() => Promise<number>>().mockResolvedValue(1);
  observe(read);
  await vi.advanceTimersByTimeAsync(0);
  const stop = subscribeToInsightChanges('workspace', client);
  change();
  stop();
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledOnce();
  expect(stream.mock.results[0]!.value).toHaveBeenCalledOnce();
});
