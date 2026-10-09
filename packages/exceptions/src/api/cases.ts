import '@luma/identity/http';

import {
  apiContract,
  caseDetailSchema,
  caseEvidencePageSchema,
  caseListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { CaseService } from '../application/cases.js';

/** Creates tenant-scoped case, investigation, and evidence handlers with validated responses. */
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

  const os = implement(apiContract.exceptions).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        const { context, service } = use(request);

        return caseListSchema.parse(await service.list(context, query));
      },
    ),
    evidence: os.evidence.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const { context, service } = use(request);
        const body = await service.evidence(context, params.exceptionId, query);
        if (!body) throw new IdentityError(404, 'NOT_FOUND', 'Case not found');

        return caseEvidencePageSchema.parse(body);
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      const { context, service } = use(request);
      const body = await service.get(context, params.exceptionId);
      if (!body) throw new IdentityError(404, 'NOT_FOUND', 'Case not found');

      return caseDetailSchema.parse(body);
    }),
  });
}
