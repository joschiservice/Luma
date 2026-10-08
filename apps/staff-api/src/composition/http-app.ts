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
  registerStaffHttp(app, staff);
  app.addHook('onClose', () => staff.close());

  return app;
}
