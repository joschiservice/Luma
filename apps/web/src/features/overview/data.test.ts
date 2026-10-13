import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import { overviewOptions, overviewSearch } from './data';

afterEach(() => vi.unstubAllGlobals());

it('separates organization and window caches and refreshes on reconnect', () => {
  expect(overviewOptions('a', '24h').queryKey).not.toEqual(
    overviewOptions('b', '24h').queryKey,
  );
  expect(overviewOptions('a', '24h').queryKey).not.toEqual(
    overviewOptions('a', '7d').queryKey,
  );
  expect(overviewOptions('a', '24h')).toMatchObject({
    gcTime: 0,
    refetchInterval: 30000,
    refetchOnReconnect: 'always',
  });
  expect(overviewSearch.parse({ window: 'bad' })).toEqual({ window: '24h' });
});

it('rejects unauthorized and malformed summaries without caching totals', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  try {
    await expect(
      client.fetchQuery(overviewOptions('a', '24h')),
    ).rejects.toThrow();
    await expect(
      client.fetchQuery(overviewOptions('b', '24h')),
    ).rejects.toThrow();
    expect(
      client.getQueryData(overviewOptions('a', '24h').queryKey),
    ).toBeUndefined();
  } finally {
    client.clear();
  }
});

it('isolates exact brief windows from rolling Home caches', () => {
  const a = { start: '2026-10-24T06:00:00Z', end: '2026-10-25T07:00:00Z' };
  const b = { start: '2026-10-25T07:00:00Z', end: '2026-10-26T07:00:00Z' };
  expect(overviewOptions('a', '24h', a).queryKey).not.toEqual(
    overviewOptions('a', '24h').queryKey,
  );
  expect(overviewOptions('a', '24h', a).queryKey).not.toEqual(
    overviewOptions('a', '24h', b).queryKey,
  );
});
