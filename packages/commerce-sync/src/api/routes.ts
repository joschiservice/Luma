import '@luma/identity/http';

import {
  apiContract,
  identityDetailSchema,
  linkRequestSchema,
  syncOverviewSchema,
  syncStreamSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { SyncService } from '../application/service.js';

/** Exposes sync status to members, and sync controls and link requests to people with `sync.manage`. */
export function syncRoutes(service?: SyncService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Data sync is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.sync, {
    overview: async ({ request }) => {
      const s = use(request);

      return {
        status: 200,
        body: syncOverviewSchema.parse(await s.service.overview(s.context)),
      };
    },
    command: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: syncStreamSchema.parse(
          await s.service.command(s.context, params.streamId, body.command),
        ),
      };
    },
    identity: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: identityDetailSchema.parse(
          await s.service.identity(s.context, params.kind, params.entityId),
        ),
      };
    },
    requestLink: async ({ request, body }) => {
      const s = use(request);

      return {
        status: 202,
        body: linkRequestSchema.parse(
          await s.service.requestLink(s.context, body),
        ),
      };
    },
    linkRequest: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: linkRequestSchema.parse(
          await s.service.linkRequest(s.context, params.requestId),
        ),
      };
    },
  });
}
