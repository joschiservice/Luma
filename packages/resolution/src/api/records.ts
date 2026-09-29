import '@luma/identity/http';

import {
  apiContract,
  recordDetailSchema,
  recordListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { RecordExplorer } from '../application/records.js';

/** Exposes scoped record search and detail reads to workspace members. */
export function recordRoutes(service?: RecordExplorer) {
  return initServer().router(apiContract.records, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Record search is unavailable',
        );

      return {
        status: 200,
        body: recordListSchema.parse(
          await service.list(request.tenantContext, query),
        ),
      };
    },
    get: async ({ request, params }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Record details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.kind,
        params.recordId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Record not found');

      return { status: 200, body: recordDetailSchema.parse(detail) };
    },
  });
}
