import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import { metricsOptions } from './metrics-data';

afterEach(() => vi.unstubAllGlobals());

it('isolates workspace, filter and snapshot caches without retrying expired snapshots', () => {
  expect(metricsOptions('a').queryKey).not.toEqual(
    metricsOptions('b').queryKey,
  );
  expect(
    metricsOptions('a', { scope: { connectionId: 'one' } }).queryKey,
  ).not.toEqual(metricsOptions('a').queryKey);
  expect(metricsOptions('a', { snapshot: 'one' }).queryKey).not.toEqual(
    metricsOptions('a', { snapshot: 'two' }).queryKey,
  );
  expect(metricsOptions('a', { snapshot: 'one' })).toMatchObject({
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
});

it('rejects expired snapshots and malformed responses without exposing cached counts', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'CONFLICT',
            message: 'Snapshot changed',
            requestId: 'test',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  );
  const client = new QueryClient();
  try {
    await expect(client.fetchQuery(metricsOptions('a'))).rejects.toMatchObject({
      status: 409,
    });
    await expect(client.fetchQuery(metricsOptions('b'))).rejects.toThrow();
    expect(client.getQueryData(metricsOptions('a').queryKey)).toBeUndefined();
  } finally {
    client.clear();
  }
});
