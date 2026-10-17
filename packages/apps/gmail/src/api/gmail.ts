import '@luma/identity/http';

import type { IdentityService, TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

/** Completes Google authorization for the workspace named in the callback state. */
interface GmailCallback {
  config: { webOrigin: string };
  callbackTenant(query: string): string;
  /** Resolves to the outcome shown on the settings page. */
  callback(context: TenantContext, query: string): Promise<string>;
}

/** Verifies and records one push notification; resolves after durable intake. */
type PushIntake = (
  authorization: string | undefined,
  body: unknown,
) => Promise<void>;

/**
 * Registers the Google authorization callback and the Pub/Sub push endpoint. Both
 * authenticate themselves: the callback through its stored state and the signed-in session,
 * push through Google's signed OIDC token.
 */
export function registerGmailRoutes(
  app: FastifyInstance,
  oauth: GmailCallback | undefined,
  identity: Pick<IdentityService, 'resolveTenant'> | undefined,
  push: PushIntake,
) {
  app.get(
    '/v1/gmail/callback',
    { config: { authentication: 'app' } },
    async (request, reply) => {
      if (!oauth || !identity)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Gmail is not configured',
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
        `${oauth.config.webOrigin}/app/${tenant}/apps/gmail/settings?appResult=${result}`,
      );
    },
  );
  app.post(
    '/v1/gmail/push',
    { config: { authentication: 'app' } },
    async (request, reply) => {
      await push(request.headers.authorization, request.body);

      return reply.status(204).send();
    },
  );
}
