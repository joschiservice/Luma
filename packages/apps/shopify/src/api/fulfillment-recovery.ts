import '@luma/identity/http';

import { ConnectorError } from '@luma/connections';
import { AdmissionRejected } from '@luma/execution';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { createFulfillmentRecovery } from '../application/fulfillment-recovery.js';

/** Registers private fulfillment previews, approvals and reference-only execution commands. */
export function registerRecoveryRoutes(
  server: FastifyInstance,
  service: ReturnType<typeof createFulfillmentRecovery>,
) {
  for (const command of [
    'inspect',
    'preview',
    'execute',
    'approve',
    'check',
  ] as const) {
    server.post(
      `/v1/organizations/:organizationId/apps/shopify/fulfillment-recovery-${command}`,
      {
        config: { access: { permission: 'shopify:fulfillment_recovery.run' } },
      },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue.',
          );
        try {
          return await service[command](request.tenantContext, request.body);
        } catch (error) {
          if (error instanceof ZodError)
            throw new IdentityError(
              422,
              'CONFLICT',
              'Choose a valid fulfillment action.',
            );
          if (error instanceof AdmissionRejected)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This action is no longer eligible. Refresh fulfillment details.',
            );
          if (
            error instanceof ConnectorError &&
            error.failure.code === 'not_found'
          )
            throw new IdentityError(
              404,
              'NOT_FOUND',
              'This fulfillment order was not found on the selected Shopify order.',
            );
          if (
            error instanceof ConnectorError &&
            ['authentication', 'permission_denied'].includes(error.failure.code)
          )
            throw new IdentityError(
              403,
              'FORBIDDEN',
              'Reconnect Shopify with access to this fulfillment order.',
            );
          if (error instanceof ConnectorError)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Shopify could not confirm this action. Refresh to check its status before continuing.',
            );
          throw error;
        }
      },
    );
  }
}
