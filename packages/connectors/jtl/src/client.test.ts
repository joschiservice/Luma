import { ConnectorError } from '@luma/connector-core';
import { describe, expect, it, vi } from 'vitest';

import { createClient } from './index.js';

const cloud = {
  kind: 'cloud' as const,
  jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  accessToken: async () => 'token',
};

describe('JTL package transport', () => {
  it('authenticates cloud reads and preserves the requested query', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ items: [] }));
    await createClient({ connection: cloud, fetch }).request('salesOrders', {
      pageNumber: '2',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.jtl-cloud.com/erp/v2/salesOrders?pageNumber=2',
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer token',
    );
    expect(new Headers(init?.headers).get('X-Tenant-ID')).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    );
  });

  it('refuses a path that leaves the API host before reading the credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const accessToken = vi.fn(async () => 'token');
    const client = createClient({
      connection: { ...cloud, accessToken },
      fetch,
    });
    for (const path of ['//attacker.example/x', 'https://attacker.example/x'])
      await expect(client.request(path)).rejects.toMatchObject({
        failure: { code: 'invalid_input' },
      });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a write once and requires reconciliation when its response is lost', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('connection reset'));
    const client = createClient({
      connection: cloud,
      fetch,
      readRetry: { attempts: 3, maxDelayMs: 2000, sleep: async () => {} },
    });
    await expect(
      client.request(
        'salesOrders/1',
        {},
        { body: {}, idempotencyKey: 'command' },
      ),
    ).rejects.toMatchObject({
      failure: { effect: 'unknown', retry: 'reconcile' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.request('salesOrders')).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    fetch.mockResolvedValueOnce(new Response('', { status: 502 }));
    fetch.mockResolvedValueOnce(Response.json({ items: [] }));
    await expect(client.request('salesOrders')).resolves.toEqual({
      items: [],
    });
  });

  it('rejects unencrypted remote on-premise endpoints before sending credentials', () => {
    expect(() =>
      createClient({
        connection: {
          kind: 'onprem',
          baseUrl: 'http://erp.example/database/',
          appId: 'app',
          appVersion: '1',
          challengeCode: 'challenge',
          apiKey: async () => 'secret',
        },
      }),
    ).toThrow(ConnectorError);
  });
});
