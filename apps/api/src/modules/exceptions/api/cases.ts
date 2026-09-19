import { initServer } from '@ts-rest/fastify';
import {
  apiContract,
  caseDetailSchema,
  caseListSchema,
  caseEvidencePageSchema,
} from '@luma/api-contract';
import { IdentityError } from '#modules/identity/index';
import type { CaseService } from '#modules/exceptions/application/cases';
import type { FastifyRequest } from 'fastify';

export function caseRoutes(service?: CaseService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Case reads are unavailable',
      );
    return { context: request.tenantContext, service };
  }
  return initServer().router(apiContract.exceptions, {
    list: async ({ request, query }) => {
      const { context, service } = use(request);
      return {
        status: 200,
        body: caseListSchema.parse(await service.list(context, query)),
      };
    },
    evidence: async ({ request, params, query }) => {
      const { context, service } = use(request);
      const body = await service.evidence(context, params.exceptionId, query);
      if (!body) throw new IdentityError(404, 'NOT_FOUND', 'Case not found');
      return { status: 200, body: caseEvidencePageSchema.parse(body) };
    },
    get: async ({ request, params }) => {
      const { context, service } = use(request);
      const body = await service.get(context, params.exceptionId);
      if (!body) throw new IdentityError(404, 'NOT_FOUND', 'Case not found');
      return { status: 200, body: caseDetailSchema.parse(body) };
    },
  });
}
