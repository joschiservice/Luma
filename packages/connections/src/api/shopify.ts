import type { IdentityService } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ShopifyOAuth } from '../application/shopify.js';

/**
 * Registers Shopify authorization callbacks and uninstall webhooks with signature and
 * session validation.
 */
export function registerShopifyRoutes(
  app: FastifyInstance,
  oauth?: ShopifyOAuth,
  identity?: Pick<IdentityService, 'resolveTenant'>,
) {
  app.get('/v1/shopify/callback', async (request, reply) => {
    if (!oauth || !identity)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Shopify is not configured',
      );
    const query = request.url.split('?')[1] ?? '';
    const tenant = oauth.callbackTenant(query);
    let result: string;
    try {
      const context = await identity.resolveTenant(
        request.headers.cookie ? { cookie: request.headers.cookie } : {},
        tenant,
        request.id,
      );
      result = await oauth.callback(context, query);
    } catch {
      result = 'failed';
    }
    reply.header('referrer-policy', 'no-referrer');

    return reply.redirect(
      `${oauth.config.webOrigin}/app/${tenant}/connections?shopify=${result}`,
    );
  });
  app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1048576 },
      (_request, body, done) => done(null, body),
    );
    webhook.post(
      '/v1/shopify/uninstall/:organizationId/:connectionId',
      async (request, reply) => {
        if (!oauth)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Shopify is not configured',
          );
        const params = z
          .object({
            organizationId: z.string().uuid(),
            connectionId: z.string().uuid(),
          })
          .parse(request.params);
        const header = (name: string) =>
          typeof request.headers[name] === 'string'
            ? (request.headers[name] as string)
            : '';
        await oauth.uninstall(
          params.organizationId,
          params.connectionId,
          request.body as Buffer,
          header('x-shopify-hmac-sha256'),
          header('x-shopify-shop-domain'),
          header('x-shopify-topic'),
        );

        return reply.status(204).send();
      },
    );
  });
}
