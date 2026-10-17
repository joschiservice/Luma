import '@luma/identity/http';

import { ConnectorError } from '@luma/connections';
import { AdmissionRejected } from '@luma/execution';
import {
  conflict,
  forbidden,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { createOrderEdits } from '../application/order-edits.js';
import { orderEditPermission } from '../domain/order-edits.js';

/** Registers private order edit previews, approvals and reference-only execution commands. */
export function registerOrderEditRoutes(
  server: FastifyInstance,
  service: ReturnType<typeof createOrderEdits>,
) {
  for (const command of [
    'recent',
    'inspect',
    'preview',
    'execute',
    'approve',
    'check',
  ] as const) {
    server.post(
      `/v1/organizations/:organizationId/apps/shopify/order-edit-${command}`,
      { config: { access: { permission: orderEditPermission } } },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (!request.tenantContext)
          throw new ServiceError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue.',
          );
        try {
          return await service[command](request.tenantContext, request.body);
        } catch (error) {
          if (error instanceof ZodError)
            throw new ServiceError(
              422,
              'CONFLICT',
              'Choose order lines and whole, nonnegative quantities.',
            );
          if (error instanceof AdmissionRejected)
            throw conflict(
              'This edit is no longer eligible. Refresh the order.',
            );
          if (
            error instanceof ConnectorError &&
            error.failure.code === 'not_found'
          )
            throw notFound(
              'This order was not found in the selected Shopify store.',
            );
          if (
            error instanceof ConnectorError &&
            ['authentication', 'permission_denied'].includes(error.failure.code)
          )
            throw forbidden('Reconnect Shopify with order edit access.');
          if (
            error instanceof ConnectorError &&
            error.failure.code === 'conflict'
          )
            throw conflict(
              'Shopify refused to calculate this edit. Refresh the order and review its lines.',
            );
          if (error instanceof ConnectorError)
            throw unavailable(
              'Shopify could not confirm this edit. Refresh to check its status before continuing.',
            );
          throw error;
        }
      },
    );
  }
}
