import '@luma/identity/http';

import {
  apiContract,
  caseDetailSchema,
  caseEvidencePageSchema,
  caseListSchema,
  collectionQueryIssue,
  issuesCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { CaseService } from '../application/cases.js';

/**
 * Checks conditions and grouping against the issues catalog. Throws a 400 error naming the first invalid
 * condition ("Condition 2: …") or the grouping.
 */
function validateCaseQuery(query: Parameters<typeof collectionQueryIssue>[1]) {
  const message = collectionQueryIssue(issuesCatalog, query);
  if (message)
    throw Object.assign(new Error(message), { statusCode: 400, expose: true });
}

/** Creates tenant-scoped case, investigation, and evidence handlers with validated responses. */
export function caseRoutes(service?: CaseService) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw unavailable('Case reads are unavailable');

    return { context: request.tenantContext, service };
  }

  const os = implement(apiContract.exceptions).$context<HttpContext>();

  return os.router({
    assignOwner: os.assignOwner.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.assignOwner(s.context, params.exceptionId, body);
      },
    ),
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        const { context, service } = use(request);
        validateCaseQuery(query);

        return caseListSchema.parse(await service.list(context, query));
      },
    ),
    evidence: os.evidence.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const { context, service } = use(request);
        const body = await service.evidence(context, params.exceptionId, query);
        if (!body) throw notFound('Case not found');

        return caseEvidencePageSchema.parse(body);
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      const { context, service } = use(request);
      const body = await service.get(context, params.exceptionId);
      if (!body) throw notFound('Case not found');

      return caseDetailSchema.parse(body);
    }),
  });
}
