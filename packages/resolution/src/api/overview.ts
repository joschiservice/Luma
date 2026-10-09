import '@luma/identity/http';

import {
  apiContract,
  measurementEventSchema,
  measurementHistorySchema,
  operationsOverviewSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { OperationsOverviewService } from '../application/overview.js';

/** Creates tenant-scoped operations-summary handlers for the requested reporting window. */
export function operationsRoutes(
  service?: OperationsOverviewService,
  measurements?: import('../application/measurement.js').MeasurementService,
) {
  const os = implement(apiContract.operations).$context<HttpContext>();

  return os.router({
    recordMeasurement: os.recordMeasurement.handler(
      async ({ context: { request }, input: { params, body } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!measurements)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Measurements are unavailable',
          );

        return measurementEventSchema.parse(
          await measurements.append(
            request.tenantContext,
            params.exceptionId,
            body,
          ),
        );
      },
    ),
    measurementHistory: os.measurementHistory.handler(
      async ({ context: { request }, input: { params, query } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!measurements)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Measurements are unavailable',
          );

        return measurementHistorySchema.parse(
          await measurements.history(
            request.tenantContext,
            params.exceptionId,
            query.after,
          ),
        );
      },
    ),
    overview: os.overview.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!service)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Operations overview is unavailable',
          );

        return operationsOverviewSchema.parse(
          await service(request.tenantContext, query.window),
        );
      },
    ),
  });
}
