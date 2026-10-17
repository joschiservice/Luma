import { ServiceError } from '@luma/platform';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { ShopifyOAuth } from '../application/oauth.js';
import { registerShopifyRoutes } from './shopify.js';

const tenant = '11111111-1111-4111-8111-111111111111';

function oauth(): ShopifyOAuth {
  return {
    config: { webOrigin: 'https://luma.test' },
    start: vi.fn(),
    access: vi.fn(),
    credential: vi.fn(),
    uninstall: vi.fn(),
    scopesUpdated: vi.fn(),
    changed: vi.fn(),
    callbackTenant: () => tenant,
    callback: vi.fn(),
  };
}

it.each([401, 403, 404] as const)(
  'redirects to recovery when callback identity fails with %s',
  async (status) => {
    const app = Fastify();
    const service = oauth();
    registerShopifyRoutes(app, service, {
      resolveTenant: vi
        .fn()
        .mockRejectedValue(
          new ServiceError(status, 'UNAUTHENTICATED', 'Sign in again'),
        ),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/shopify/callback?code=private-code',
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `https://luma.test/app/${tenant}/apps/shopify/settings?appResult=failed`,
      );
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).not.toContain('private-code');
      expect(service.callback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('passes the original webhook bytes to signature verification', async () => {
  const app = Fastify();
  const service = oauth();
  registerShopifyRoutes(app, service);
  const body = '{ "myshopify_domain": "shop.myshopify.com" }';
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/shopify/uninstall/${tenant}/${tenant}`,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'signature',
        'x-shopify-shop-domain': 'shop.myshopify.com',
        'x-shopify-topic': 'app/uninstalled',
      },
      payload: body,
    });
    expect(response.statusCode).toBe(204);
    expect(service.uninstall).toHaveBeenCalledWith(
      tenant,
      tenant,
      Buffer.from(body),
      'signature',
      'shop.myshopify.com',
      'app/uninstalled',
    );
  } finally {
    await app.close();
  }
});

it('schedules record-change notifications from the original bytes', async () => {
  const app = Fastify();
  const service = oauth();
  registerShopifyRoutes(app, service);
  const body = '{ "id": 10 }';
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/shopify/changes/${tenant}/${tenant}`,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'signature',
        'x-shopify-shop-domain': 'shop.myshopify.com',
        'x-shopify-topic': 'orders/updated',
        'x-shopify-event-id': 'event-1',
      },
      payload: body,
    });
    expect(response.statusCode).toBe(204);
    expect(service.changed).toHaveBeenCalledWith(
      tenant,
      tenant,
      Buffer.from(body),
      'signature',
      'shop.myshopify.com',
      'orders/updated',
      'event-1',
    );
  } finally {
    await app.close();
  }
});

it('acknowledges compliance intake only after persistence and preserves original bytes', async () => {
  const app = Fastify();
  const privacy = vi.fn().mockResolvedValue(undefined);
  registerShopifyRoutes(app, undefined, undefined, privacy);
  const payload = '{ "shop_id": 123, "shop_domain": "shop.myshopify.com" }';
  const request = {
    method: 'POST' as const,
    url: '/v1/shopify/privacy',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': 'sig',
      'x-shopify-shop-domain': 'shop.myshopify.com',
      'x-shopify-topic': 'shop/redact',
    },
    payload,
  };
  try {
    expect((await app.inject(request)).statusCode).toBe(204);
    expect(privacy).toHaveBeenCalledWith(
      Buffer.from(payload),
      'sig',
      'shop.myshopify.com',
      'shop/redact',
    );
    privacy.mockRejectedValue(new Error('Persistence failed'));
    expect((await app.inject(request)).statusCode).toBe(500);
  } finally {
    await app.close();
  }
});
