import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import { metricsOptions } from './metrics-data';

afterEach(() => vi.unstubAllGlobals());

it('isolates workspace, filter and page caches without retrying failed reads', () => {
  expect(metricsOptions('a').queryKey).not.toEqual(
    metricsOptions('b').queryKey,
  );
  expect(
    metricsOptions('a', { scope: { connectionId: 'one' } }).queryKey,
  ).not.toEqual(metricsOptions('a').queryKey);
  expect(metricsOptions('a', { cursor: 'one' }).queryKey).not.toEqual(
    metricsOptions('a', { cursor: 'two' }).queryKey,
  );
  expect(metricsOptions('a', { cursor: 'one' })).toMatchObject({
    gcTime: 0,
    retry: false,
  });
});

it('rejects failed and malformed responses without exposing cached counts', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Operational metrics are unavailable',
            requestId: 'test',
          }),
          {
            status: 503,
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
      status: 503,
    });
    await expect(client.fetchQuery(metricsOptions('b'))).rejects.toThrow();
    expect(client.getQueryData(metricsOptions('a').queryKey)).toBeUndefined();
  } finally {
    client.clear();
  }
});
