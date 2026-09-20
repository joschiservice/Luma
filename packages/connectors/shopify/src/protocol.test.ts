import { createHmac } from 'node:crypto';

import { ConnectorError } from '@luma/connector-core';
import { describe, expect, it, vi } from 'vitest';

import {
  API_VERSION,
  callbackParams,
  createClient,
  createOAuthClient,
  verifyWebhook,
} from './index.js';

const config = { clientId: 'client', clientSecret: 'secret' };

describe('Shopify package protocols', () => {
  it('exchanges codes and refreshes tokens without tenant or storage dependencies', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 60,
          refresh_token_expires_in: 120,
          scope: 'read_orders, read_products',
        }),
      );
    const client = createOAuthClient(
      config,
      fetch,
      () => new Date('2026-09-20T00:00:00Z'),
    );
    const token = await client.token('example.myshopify.com', { code: 'code' });
    expect(token).toEqual({
      token: 'access',
      refreshToken: 'refresh',
      expiresAt: '2026-09-20T00:01:00.000Z',
      refreshExpiresAt: '2026-09-20T00:02:00.000Z',
      scopes: ['read_orders', 'read_products'],
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: 'client',
      client_secret: 'secret',
      code: 'code',
      expiring: 1,
    });
    await client.token('example.myshopify.com', { refresh_token: 'refresh' });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      client_id: 'client',
      client_secret: 'secret',
      refresh_token: 'refresh',
      grant_type: 'refresh_token',
    });
  });

  it('rejects a tampered callback and duplicate signed parameters', () => {
    const message = 'code=code&shop=example.myshopify.com&state=state';
    const mac = createHmac('sha256', config.clientSecret)
      .update(message)
      .digest('hex');
    expect(
      callbackParams(`${message}&hmac=${mac}`, config.clientSecret).get('code'),
    ).toBe('code');
    expect(() =>
      callbackParams(`${message}&hmac=${mac}&code=other`, config.clientSecret),
    ).toThrow();
    expect(() =>
      callbackParams(
        `${message.replace('state=state', 'state=other')}&hmac=${mac}`,
        config.clientSecret,
      ),
    ).toThrow();
  });

  it('verifies the original webhook bytes and expected shop', () => {
    const body = Buffer.from('{"id":1}');
    const options = {
      body,
      secret: 'secret',
      shop: 'example.myshopify.com',
      expectedShop: 'example.myshopify.com',
      eventId: 'event',
      hmac: createHmac('sha256', 'secret').update(body).digest('base64'),
    };
    expect(() => verifyWebhook(options)).not.toThrow();
    expect(() =>
      verifyWebhook({ ...options, body: Buffer.from('{"id":2}') }),
    ).toThrow(ConnectorError);
    expect(() =>
      verifyWebhook({ ...options, shop: 'other.myshopify.com' }),
    ).toThrow(ConnectorError);
  });

  it('resolves credentials per request and preserves normalized transport failures', async () => {
    const accessToken = vi
      .fn()
      .mockResolvedValue('current')
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json(
          { data: { shop: { id: 'id' } } },
          { headers: { 'X-Shopify-API-Version': API_VERSION } },
        ),
      );
    const request = createClient({
      shop: 'example.myshopify.com',
      accessToken,
      fetch,
    });
    await request('query { shop { id } }', {});
    await request('query { shop { id } }', {});
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get(
        'X-Shopify-Access-Token',
      ),
    ).toBe('second');
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(request('query { shop { id } }', {})).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
