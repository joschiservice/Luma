import '@luma/identity/http';

import { ConnectorError } from '@luma/connections';
import { AdmissionRejected } from '@luma/execution';
import { IdentityError } from '@luma/identity';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { createInventoryCorrection } from '../application/inventory-correction.js';

/** Registers private inventory previews, approvals and reference-only execution commands. */
export function registerInventoryCorrectionRoutes(
  server: FastifyInstance,
  service: ReturnType<typeof createInventoryCorrection>,
) {
  for (const command of [
    'candidates',
    'inspect',
    'preview',
    'execute',
    'approve',
    'check',
  ] as const) {
    server.post(
      `/v1/organizations/:organizationId/apps/shopify/inventory-correction-${command}`,
      {
        config: {
          access: { permission: 'shopify:inventory_corrections.apply' },
        },
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
              'Choose a valid stock position and ERP source.',
            );
          if (error instanceof AdmissionRejected)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This action is no longer eligible. Refresh inventory details.',
            );
          if (
            error instanceof ConnectorError &&
            error.failure.code === 'not_found'
          )
            throw new IdentityError(
              404,
              'NOT_FOUND',
              'This Shopify inventory item or location was not found.',
            );
          if (
            error instanceof ConnectorError &&
            ['authentication', 'permission_denied'].includes(error.failure.code)
          )
            throw new IdentityError(
              403,
              'FORBIDDEN',
              'Reconnect Shopify with access to this inventory item and location.',
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
