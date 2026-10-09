import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import { createWebApiClient } from '../../lib/api-client';
import { connectorProviderQueryOptions } from './queries';

afterEach(() => vi.unstubAllGlobals());

it('consumes the shared contract through the web Query client', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ id: 'shopify', name: 'Shopify', category: 'storefront' }),
    );
  vi.stubGlobal('fetch', fetch);
  const queryClient = new QueryClient();
  const result = await queryClient.fetchQuery(
    connectorProviderQueryOptions(createWebApiClient(), 'shopify'),
  );
  expect(result.name).toBe('Shopify');
  expect(fetch).toHaveBeenCalledOnce();
  const request: Request = fetch.mock.calls[0]![0];
  expect(new URL(request.url).pathname).toBe(
    '/api/v1/connector-providers/shopify',
  );
  expect(request.method).toBe('GET');
  expect(request.signal).toBeInstanceOf(AbortSignal);
  expect(request.headers.get('x-luma-action-id')).toMatch(/^[0-9a-f-]{36}$/);
  queryClient.clear();
});

it('rejects malformed server data before it enters the cache', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ id: 'shopify', name: 123 })),
  );
  const queryClient = new QueryClient();
  await expect(
    queryClient.fetchQuery(
      connectorProviderQueryOptions(createWebApiClient(), 'shopify'),
    ),
  ).rejects.toThrow();
  expect(
    queryClient.getQueryData(['connector-providers', 'shopify']),
  ).toBeUndefined();
  queryClient.clear();
});

it('exposes a documented error without treating it as provider data', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          code: 'NOT_FOUND',
          message: 'Provider not found',
          requestId: 'test',
        },
        { status: 404 },
      ),
    ),
  );
  const queryClient = new QueryClient();
  await expect(
    queryClient.fetchQuery(
      connectorProviderQueryOptions(createWebApiClient(), 'missing'),
    ),
  ).rejects.toThrow('Provider not found');
  queryClient.clear();
});
