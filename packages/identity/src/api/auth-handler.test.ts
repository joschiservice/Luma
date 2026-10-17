import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { registerAuthHandler } from './auth-handler.js';

const origin = 'https://app.example.test';

/** Forwards one sign-in through the bridge and returns the headers Better Auth received. */
async function forwarded(
  headers: Record<string, string>,
  clientIpHeader?: string,
) {
  const app = Fastify();
  const handler = vi.fn(async (request: Request) =>
    Response.json({ method: request.method }),
  );
  registerAuthHandler(app, handler, origin, undefined, clientIpHeader);
  const response = await app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers,
    payload: {},
    remoteAddress: '198.51.100.7',
  });
  expect(response.statusCode).toBe(200);
  await app.close();

  return handler.mock.calls[0]![0].headers;
}

it('uses the socket address and replaces a client-sent address header', async () => {
  const headers = await forwarded({
    'x-forwarded-for': '203.0.113.9',
    'x-luma-client-ip': '203.0.113.9',
  });

  expect(headers.get('x-luma-client-ip')).toBe('198.51.100.7');
});

it('takes the last entry of the configured proxy header', async () => {
  const headers = await forwarded(
    { 'x-forwarded-for': '203.0.113.9, 192.0.2.44' },
    'x-forwarded-for',
  );

  expect(headers.get('x-luma-client-ip')).toBe('192.0.2.44');
  expect((await forwarded({}, 'x-real-ip')).get('x-luma-client-ip')).toBe(
    '198.51.100.7',
  );
});

it('exposes email confirmation and keeps other auth routes closed', async () => {
  const app = Fastify();
  const handler = vi.fn(async () => Response.json({ status: true }));
  registerAuthHandler(app, handler, origin);

  const sent = await app.inject({
    method: 'POST',
    url: '/auth/send-verification-email',
    payload: {},
  });
  const confirmed = await app.inject({ url: '/auth/verify-email?token=t' });

  expect([sent.statusCode, confirmed.statusCode]).toEqual([200, 200]);
  expect(
    (await app.inject({ method: 'POST', url: '/auth/change-email' }))
      .statusCode,
  ).toBe(404);
  await app.close();
});
