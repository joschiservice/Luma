import '@luma/identity/http';

import {
  apiContract,
  shadowComparisonSchema,
  shadowEvaluationSchema,
  shadowReportSchema,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ShadowService } from '../application/shadow.js';

/** Exposes authorized Shadow evaluation, operator evidence and comparison reports. */
export function shadowRoutes(service?: ShadowService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw unavailable('Shadow evaluation is unavailable');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.shadow).$context<HttpContext>();

  return os.router({
    latest: os.latest.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);
        const result = await s.service.latest(
          s.context,
          params.exceptionId,
          query.workflow,
        );

        return {
          item: result.item ? shadowComparisonSchema.parse(result.item) : null,
        };
      },
    ),
    evaluate: os.evaluate.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return shadowEvaluationSchema.parse(
          await s.service.evaluate(s.context, params.exceptionId, body),
        );
      },
    ),
    review: os.review.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.review(s.context, params.evaluationId, body);
      },
    ),
    report: os.report.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);

        return shadowReportSchema.parse(
          await s.service.report(s.context, query),
        );
      },
    ),
  });
}
