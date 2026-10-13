import { ConnectorError } from '@luma/connector-core';
import { describe, expect, it, vi } from 'vitest';

import { createClient } from './client.js';

const credentials = async () => ({
  token: 'api-key',
  subscriptionKey: 'subscription-key',
});
describe('Starshipit transport', () => {
  it('refreshes both credentials per request and uses only the fixed API host', async () => {
    const resolve = vi.fn(credentials);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: true, order: {} }),
    );
    const client = createClient({ credentials: resolve, fetch });
    await client.read('orders', new URLSearchParams({ order_id: '1' }));
    await client.update({ order_id: 1 });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://api.starshipit.com/api/orders?order_id=1',
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      headers: {
        'StarShipIT-Api-Key': 'api-key',
        'Ocp-Apim-Subscription-Key': 'subscription-key',
      },
    });
  });
  it('retries a short rate-limited read but never a dispatched write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockRejectedValueOnce(new TypeError('raw private provider failure'));
    const client = createClient({
      credentials,
      fetch,
      readRetry: { attempts: 3, maxDelayMs: 1000, sleep: async () => {} },
    });
    await client.read('orders', new URLSearchParams());
    await expect(client.update({ order_id: 1 })).rejects.toMatchObject({
      failure: { effect: 'unknown', retry: 'never' },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([500, 503])(
    'a provider %s after write dispatch is uncertain',
    async (status) => {
      const client = createClient({
        credentials,
        fetch: async () => new Response(null, { status }),
      });
      await expect(client.update({})).rejects.toBeInstanceOf(ConnectorError);
      await expect(client.update({})).rejects.toMatchObject({
        failure: { effect: 'unknown', retry: 'never' },
      });
    },
  );
  it('malformed or unsuccessful write envelopes remain uncertain', async () => {
    const client = createClient({
      credentials,
      fetch: async () =>
        Response.json({ success: false, errors: [{ message: 'private' }] }),
    });
    await expect(client.update({})).rejects.toMatchObject({
      failure: { code: 'invalid_response', effect: 'unknown' },
    });
  });
});
