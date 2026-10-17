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

import type { createInventoryCorrection } from '../application/inventory-correction.js';

/** Registers private inventory previews, approvals and reference-only execution commands. */
export function registerInventoryCorrectionRoutes(
  server: FastifyInstance,
  service: ReturnType<typeof createInventoryCorrection> & {
    receiptPreview(
      context: import('@luma/identity').TenantContext,
      input: unknown,
    ): Promise<unknown>;
    receiptState(
      context: import('@luma/identity').TenantContext,
      input: unknown,
    ): Promise<unknown>;
  },
) {
  for (const command of [
    'candidates',
    'inspect',
    'preview',
    'execute',
    'approve',
    'check',
    'receiptPreview',
    'receiptState',
  ] as const) {
    server.post(
      `/v1/organizations/:organizationId/apps/shopify/inventory-correction-${command === 'receiptPreview' ? 'receipt-preview' : command === 'receiptState' ? 'receipt-state' : command}`,
      {
        config: {
          access: { permission: 'shopify:inventory_corrections.apply' },
        },
      },
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
              'Choose a valid stock position and approved source.',
            );
          if (error instanceof AdmissionRejected)
            throw conflict(
              'This action is no longer eligible. Refresh inventory details.',
            );
          if (
            error instanceof ConnectorError &&
            error.failure.code === 'not_found'
          )
            throw notFound(
              'This Shopify inventory item or location was not found.',
            );
          if (
            error instanceof ConnectorError &&
            ['authentication', 'permission_denied'].includes(error.failure.code)
          )
            throw forbidden(
              'Reconnect Shopify with access to this inventory item and location.',
            );
          if (error instanceof ConnectorError)
            throw unavailable(
              'Shopify could not confirm this action. Refresh to check its status before continuing.',
            );
          throw error;
        }
      },
    );
  }
}
