import { subscribeToMetrics } from '@luma/api-contract/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { subscribeToWorkspaceMetrics } from './metric-subscription';

vi.mock('@luma/api-contract/client', () => ({ subscribeToMetrics: vi.fn() }));

const transport = vi.mocked(subscribeToMetrics);
const cleanup: (() => void)[] = [];
const event = {
  schemaVersion: 1 as const,
  organizationId: 'workspace',
  scope: 'order-metrics' as const,
  connected: true,
  refetch: false,
  topics: [] as string[],
  sentAt: '2026-09-28T00:00:00.000Z',
};
const subscriber = () => ({ onResync: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  transport.mockReset().mockImplementation(() => vi.fn());
});

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shares a stream, resynchronizes late consumers and closes only after the last consumer', () => {
  const orders = subscriber();
  const summary = subscriber();
  const closeOrders = subscribeToWorkspaceMetrics('workspace', orders);
  cleanup.push(closeOrders);
  transport.mock.calls[0]![0].onResync(event);
  const closeSummary = subscribeToWorkspaceMetrics('workspace', summary);
  cleanup.push(closeSummary);
  expect(transport).toHaveBeenCalledOnce();
  expect(summary.onResync).toHaveBeenCalledWith({
    ...event,
    refetch: true,
    topics: expect.arrayContaining(['orders', 'decisions']),
  });
  const closeTransport = transport.mock.results[0]!.value;
  closeOrders();
  expect(closeTransport).not.toHaveBeenCalled();
  transport.mock.calls[0]![0].onResync({ ...event, refetch: true });
  expect(orders.onResync).toHaveBeenCalledTimes(1);
  expect(summary.onResync).toHaveBeenCalledTimes(2);
  closeSummary();
  expect(closeTransport).toHaveBeenCalledOnce();
});

it('isolates workspaces and reconnects once for all consumers after offline recovery', () => {
  const orders = subscriber();
  const summary = subscriber();
  cleanup.push(subscribeToWorkspaceMetrics('workspace', orders));
  cleanup.push(subscribeToWorkspaceMetrics('workspace', summary));
  cleanup.push(subscribeToWorkspaceMetrics('other', subscriber()));
  expect(transport).toHaveBeenCalledTimes(2);
  vi.stubGlobal('navigator', { onLine: false });
  window.dispatchEvent(new Event('offline'));
  expect(orders.onError).toHaveBeenCalledOnce();
  expect(summary.onError).toHaveBeenCalledOnce();
  vi.stubGlobal('navigator', { onLine: true });
  window.dispatchEvent(new Event('online'));
  expect(transport).toHaveBeenCalledTimes(4);
  expect(
    transport.mock.calls.slice(2).map(([options]) => options.organizationId),
  ).toEqual(['workspace', 'other']);
});

it('retries rejected streams and cancels recovery when the page leaves', () => {
  const observer = subscriber();
  const close = subscribeToWorkspaceMetrics('workspace', observer);
  cleanup.push(close);
  transport.mock.calls[0]![0].onError();
  expect(observer.onError).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(transport).toHaveBeenCalledTimes(2);
  transport.mock.calls[1]![0].onError();
  close();
  vi.advanceTimersByTime(30000);
  window.dispatchEvent(new Event('online'));
  expect(transport).toHaveBeenCalledTimes(2);
});

it('detects a silent stream and requests fresh state after reopening it', () => {
  const observer = subscriber();
  cleanup.push(subscribeToWorkspaceMetrics('workspace', observer));
  transport.mock.calls[0]![0].onResync(event);
  vi.advanceTimersByTime(15000);
  expect(observer.onError).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(15000);
  expect(transport).toHaveBeenCalledTimes(2);
});
