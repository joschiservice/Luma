import { IdentityError } from '@luma/identity';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { ShopifyOAuth } from '../application/shopify.js';
import { registerShopifyRoutes } from './shopify.js';

const tenant = '11111111-1111-4111-8111-111111111111';

function oauth(): ShopifyOAuth {
  return {
    config: { webOrigin: 'https://luma.test' },
    start: vi.fn(),
    credential: vi.fn(),
    uninstall: vi.fn(),
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
          new IdentityError(status, 'UNAUTHENTICATED', 'Sign in again'),
        ),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/shopify/callback?code=private-code',
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `https://luma.test/app/${tenant}/connections?shopify=failed`,
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
