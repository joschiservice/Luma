import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ScopedAutonomy } from '../application/scoped-autonomy.js';

/** Registers server-authorized versioned scoped-autonomy reads and commands. */
export function scopedAutonomyRoutes(service?: ScopedAutonomy) {
  const use = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Scoped autonomy is unavailable.',
      );

    return { context: request.tenantContext, service };
  };
  const os = implement(apiContract.scopedAutonomy).$context<HttpContext>();

  return os.router({
    list: os.list.handler(async ({ context: { request } }) => {
      const s = use(request);

      return s.service.list(s.context);
    }),
    save: os.save.handler(async ({ context: { request }, input: { body } }) => {
      const s = use(request);

      return s.service.save(s.context, body);
    }),
    control: os.control.handler(
      async ({ context: { request }, input: { body, params } }) => {
        const s = use(request);

        return s.service.control(s.context, params.policyId, body);
      },
    ),
    preview: os.preview.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.preview(s.context, params.policyId);
      },
    ),
  });
}
