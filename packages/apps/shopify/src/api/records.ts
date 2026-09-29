import '@luma/identity/http';

import { ConnectorError } from '@luma/connections';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';

import type { createRecordService } from '../application/records.js';

/** Registers authenticated, non-cached Shopify record reads in the workspace app namespace. */
export function registerRecordRoutes(
  server: FastifyInstance,
  read: ReturnType<typeof createRecordService>,
) {
  server.post(
    '/v1/organizations/:organizationId/apps/shopify/records',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      try {
        return await read(request.tenantContext, request.body);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        const code = error.failure.code;
        if (code === 'not_found')
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Shopify record was not found or is outside the granted order history window.',
          );
        if (code === 'permission_denied')
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'This connection does not have access to this record.',
          );
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Shopify could not load this record. Check the connection and try again.',
        );
      }
    },
  );
}
