import { randomUUID } from 'node:crypto';

import type { StaffRuntime } from '@luma/staff';
import { registerStaffHttp } from '@luma/staff/http';
import Fastify, { LogController } from 'fastify';

/**
 * Creates the staff HTTP boundary with only operator-configured ingress IPs trusted.
 * Supply the validated proxy list from staff settings; an empty list trusts no forwarded
 * addresses. The auth bridge replaces client-address headers with Fastify's resolved peer.
 * The caller owns readiness, listening and shutdown.
 */
export function createStaffHttpApp(
  staff: StaffRuntime,
  trustedProxy: readonly string[] = [],
) {
  const app = Fastify({
    logger: {
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          url: request.url.split('?')[0] ?? '/',
        }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 16 * 1024,
    trustProxy: trustedProxy.length ? [...trustedProxy] : false,
  });
  // The global console holds no regional session. Each API admits only its exact origin.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin === staff.settings.publicOrigin) {
      reply.header('Access-Control-Allow-Origin', staff.settings.publicOrigin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply.header(
          'Access-Control-Allow-Methods',
          'GET, POST, PATCH, DELETE, OPTIONS',
        );
        reply.header(
          'Access-Control-Allow-Headers',
          'Content-Type, X-Luma-Staff-Activity, X-Luma-Action-Id',
        );

        return reply.status(204).send();
      }
    }
  });
  registerStaffHttp(app, staff);
  app.addHook('onClose', () => staff.close());

  return app;
}
