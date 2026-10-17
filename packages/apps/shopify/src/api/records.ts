import '@luma/identity/http';

import { ConnectorError } from '@luma/connections';
import { forbidden, notFound, ServiceError, unavailable } from '@luma/platform';
import type { FastifyInstance } from 'fastify';

import type { createRecordService } from '../application/records.js';

/** Registers authenticated, non-cached Shopify record reads in the workspace app namespace. */
export function registerRecordRoutes(
  server: FastifyInstance,
  read: ReturnType<typeof createRecordService>,
) {
  server.post(
    '/v1/organizations/:organizationId/apps/shopify/records',
    // The record service checks the record kind's read permission and the app's scope.
    { config: { access: { access: 'member' }, readOnly: true } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      const stop = new AbortController();
      const aborted = () => stop.abort();
      const closed = () => {
        if (!reply.raw.writableFinished) stop.abort();
      };
      request.raw.on('aborted', aborted);
      reply.raw.on('close', closed);
      try {
        return await read(request.tenantContext, request.body, stop.signal);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        const code = error.failure.code;
        if (error.failure.retryAfterMs !== undefined)
          reply.header(
            'retry-after',
            String(Math.ceil(error.failure.retryAfterMs / 1000)),
          );
        if (code === 'not_found')
          throw notFound(
            'Shopify record was not found or is outside the granted order history window.',
          );
        if (code === 'permission_denied')
          throw forbidden(
            'This connection does not have access to this record.',
          );
        throw unavailable(
          'Shopify could not load this record. Check the connection and try again.',
        );
      } finally {
        request.raw.off('aborted', aborted);
        reply.raw.off('close', closed);
      }
    },
  );
}
