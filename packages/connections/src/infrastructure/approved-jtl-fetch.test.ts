import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { Readable } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

import { approvedJtlFetch } from './approved-jtl-fetch.js';

vi.mock('node:https', () => ({ request: vi.fn() }));

const endpoint = {
  tenantId: 'tenant',
  baseUrl: 'https://erp.example.test/api/company/',
  addresses: ['10.0.0.5', '2001:db8::1'],
};

const fetch = approvedJtlFetch(endpoint);

function respond(body: string | Buffer, statusCode = 200, headers = {}) {
  vi.mocked(request).mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter();

    return Object.assign(req, {
      end: () => {
        const response = Object.assign(Readable.from([Buffer.from(body)]), {
          statusCode,
          headers,
        });
        callback!(response as never);
      },
    }) as never;
  });
}

beforeEach(() => {
  vi.mocked(request).mockReset();
});

it('pins the lookup without replacing the TLS hostname or following redirects', async () => {
  respond('redirect', 302, { location: 'https://foreign.example.test/' });
  const signal = AbortSignal.timeout(15000);
  const result = await fetch(`${endpoint.baseUrl}items`, {
    headers: { Authorization: 'Wawi secret' },
    signal,
  });
  expect(result.status).toBe(302);
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = vi.mocked(request).mock.calls[0]!;
  expect(String(url)).toBe(`${endpoint.baseUrl}items`);
  expect(options).toMatchObject({
    agent: false,
    signal,
    headers: { authorization: 'Wawi secret' },
  });
  expect(options).not.toHaveProperty('rejectUnauthorized', false);
  const lookup = (
    options as {
      lookup: (
        host: string,
        options: { all: boolean },
        callback: (...args: unknown[]) => void,
      ) => void;
    }
  ).lookup;
  const callback = vi.fn();
  lookup('erp.example.test', { all: true }, callback);
  expect(callback).toHaveBeenCalledWith(null, [
    { address: '10.0.0.5', family: 4 },
    { address: '2001:db8::1', family: 6 },
  ]);
  lookup('erp.example.test', { all: false }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, '10.0.0.5', 4);
});

it('rejects other destinations, API roots, credentials and writes before opening a socket', async () => {
  for (const url of [
    'https://foreign.example.test/api/company/items',
    'https://erp.example.test/api/other/items',
    'https://erp.example.test/api/company/../other/items',
    'https://user:secret@erp.example.test/api/company/items',
  ]) {
    await expect(fetch(url)).rejects.toThrow('not approved');
  }
  for (const method of ['POST', 'PATCH']) {
    await expect(
      fetch(`${endpoint.baseUrl}items`, { method, body: '{}' }),
    ).rejects.toThrow('not approved');
  }
  expect(request).not.toHaveBeenCalled();
});

it('rejects oversized provider responses', async () => {
  respond(Buffer.alloc(1024 * 1024 + 1));
  await expect(fetch(`${endpoint.baseUrl}items`)).rejects.toThrow('size limit');
});
