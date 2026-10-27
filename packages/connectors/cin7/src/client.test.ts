import { ConnectorError } from '@luma/connector-core';
import { describe, expect, it, vi } from 'vitest';

import { createClient, createRequestPacer } from './index.js';
import { maxAdmissionWaitMs } from './pacer.js';
import { decimal, timestamp } from './schemas.js';

const connection = {
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  applicationKey: async () => 'key',
};

const noRetry = { attempts: 1, maxDelayMs: 0, sleep: async () => {} };

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) return error.failure;
    throw error;
  }
  throw new Error('Expected a connector failure');
}

describe('Cin7 transport', () => {
  it('authenticates with the account headers and keeps the query', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ Total: 0, Page: 2, SaleList: [] }));
    await createClient({ connection, fetch }).request('saleList', {
      Page: '2',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://inventory.dearsystems.com/ExternalApi/v2/saleList?Page=2',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('api-auth-accountid')).toBe(connection.accountId);
    expect(headers.get('api-auth-applicationkey')).toBe('key');
    expect(init?.redirect).toBe('error');
  });

  it('refuses a path that leaves the API host before reading the key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const applicationKey = vi.fn(async () => 'key');
    const client = createClient({
      connection: { ...connection, applicationKey },
      fetch,
    });
    for (const path of ['//attacker.example/x', 'https://attacker.example/x'])
      expect(await failure(client.request(path))).toMatchObject({
        code: 'invalid_input',
      });
    expect(applicationKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps decimal tokens exact', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"OnHand":12.50000000000,"Allocated":3}'),
      );
    await expect(
      createClient({ connection, fetch }).request('ref/productavailability'),
    ).resolves.toEqual({ OnHand: '12.50000000000', Allocated: 3 });
  });

  it('reports rejected credentials without retrying', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('Forbidden', { status: 403 }));
    expect(
      await failure(createClient({ connection, fetch }).request('me')),
    ).toEqual({ code: 'authentication', effect: 'none', retry: 'never' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits out the minute window after throttling', async () => {
    let now = 0;
    const pacer = createRequestPacer({ now: () => now, sleep: async () => {} });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 429 }));
    const client = createClient({
      connection,
      fetch,
      pacer,
      readRetry: noRetry,
    });
    expect(await failure(client.request('saleList'))).toEqual({
      code: 'rate_limited',
      effect: 'none',
      retry: 'after_delay',
      retryAfterMs: 60_000,
    });
    now = 1_000;
    expect(client.nextDelay()).toBe(59_000);
  });
});

describe('Cin7 request pacer', () => {
  it('admits one request per interval in order', async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = createRequestPacer({
      intervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((value) =>
        pacer.run(async () => {
          order.push(value);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 1000]);
  });

  it('returns a throttle cooldown to the caller instead of waiting it out', async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = createRequestPacer({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    pacer.cooldown(60_000);
    const send = vi.fn(async () => 'read');
    await expect(pacer.run(send)).rejects.toMatchObject({
      failure: {
        code: 'rate_limited',
        effect: 'none',
        retry: 'after_delay',
        retryAfterMs: 60_000,
      },
    });
    expect(send).not.toHaveBeenCalled();
    now = 60_000 - maxAdmissionWaitMs;
    await expect(pacer.run(send)).resolves.toBe('read');
    expect(waits).toEqual([maxAdmissionWaitMs]);
  });
});

describe('Cin7 values', () => {
  it('normalizes decimals and rejects unsupported precision', () => {
    expect(decimal.parse('12.50000000000')).toBe('12.5');
    expect(decimal.parse(3)).toBe('3');
    expect(decimal.parse('-0.000')).toBe('0');
    expect(decimal.safeParse('0.1234567').success).toBe(false);
    expect(decimal.safeParse('1e5').success).toBe(false);
  });

  it('reads UTC times with or without a zone', () => {
    expect(timestamp.parse('2017-11-30T00:00:00')).toBe(
      '2017-11-30T00:00:00.000Z',
    );
    expect(timestamp.parse('2017-11-22T06:58:21.8882229Z')).toBe(
      '2017-11-22T06:58:21.888Z',
    );
    expect(timestamp.safeParse('0001-01-01T00:00:00').success).toBe(false);
  });
});
