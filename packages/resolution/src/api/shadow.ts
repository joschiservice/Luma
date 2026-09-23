import '@luma/identity/http';

import {
  apiContract,
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { ShadowService } from '../application/shadow.js';

/** Exposes authorized Shadow evaluation, operator evidence and comparison reports. */
export function shadowRoutes(service?: ShadowService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Shadow evaluation is unavailable',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.shadow, {
    latest: async ({ request, params, query }) => {
      const s = use(request);
      const result = await s.service.latest(
        s.context,
        params.exceptionId,
        query.workflow,
      );

      return {
        status: 200,
        body: {
          item: result.item ? shadowComparisonSchema.parse(result.item) : null,
        },
      };
    },
    evaluate: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: shadowEvaluationSchema.parse(
          await s.service.evaluate(s.context, params.exceptionId, body),
        ),
      };
    },
    review: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.review(s.context, params.evaluationId, body),
      };
    },
    report: async ({ request, query }) => {
      const s = use(request);

      return {
        status: 200,
        body: shadowReportSchema.parse(
          await s.service.report(s.context, query),
        ),
      };
    },
  });
}
