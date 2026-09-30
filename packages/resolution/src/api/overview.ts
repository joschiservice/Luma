import '@luma/identity/http';

import {
  apiContract,
  measurementEventSchema,
  measurementHistorySchema,
  operationsOverviewSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { OperationsOverviewService } from '../application/overview.js';

/** Creates tenant-scoped operations-summary handlers for the requested reporting window. */
export function operationsRoutes(
  service?: OperationsOverviewService,
  measurements?: import('../application/measurement.js').MeasurementService,
) {
  return initServer().router(apiContract.operations, {
    recordMeasurement: async ({ request, params, body }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!measurements)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Measurements are unavailable',
        );

      return {
        status: 200,
        body: measurementEventSchema.parse(
          await measurements.append(
            request.tenantContext,
            params.exceptionId,
            body,
          ),
        ),
      };
    },
    measurementHistory: async ({ request, params, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!measurements)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Measurements are unavailable',
        );

      return {
        status: 200,
        body: measurementHistorySchema.parse(
          await measurements.history(
            request.tenantContext,
            params.exceptionId,
            query.after,
          ),
        ),
      };
    },
    overview: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Operations overview is unavailable',
        );

      return {
        status: 200,
        body: operationsOverviewSchema.parse(
          await service(request.tenantContext, query.window),
        ),
      };
    },
  });
}
