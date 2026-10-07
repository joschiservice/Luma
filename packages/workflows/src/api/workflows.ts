import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { WorkflowCatalog } from '../application/catalog.js';

/** Registers tenant-authenticated workflow reads and permission-gated controls. */
export function workflowRoutes(service?: WorkflowCatalog) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Workflows are unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.workflows, {
    evaluateCode: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.evaluateCode(
          s.context,
          params.definitionId,
          body,
        ),
      };
    },
    codeEvaluation: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.codeEvaluation(
          s.context,
          params.definitionId,
          params.evaluationId,
        ),
      };
    },
    cancelCodeEvaluation: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.cancelCodeEvaluation(
          s.context,
          params.definitionId,
          params.evaluationId,
        ),
      };
    },
    cancelCodeStep: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.cancelCodeStep(
          s.context,
          params.definitionId,
          params.runId,
          params.stepId,
        ),
      };
    },
    replenishmentSetup: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.replenishmentSetup(
          s.context,
          params.definitionId,
        ),
      };
    },
    configureReplenishment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.configureReplenishment(
          s.context,
          params.definitionId,
          body,
        ),
      };
    },
    previewReplenishment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.previewReplenishment(
          s.context,
          params.definitionId,
          body,
        ),
      };
    },
    configureReplenishmentBatch: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: {
          results: await s.service.configureReplenishmentMany(
            s.context,
            params.definitionId,
            body.items,
          ),
        },
      };
    },
    coverage: async ({ request, query }) => {
      const s = use(request);

      return {
        status: 200,
        body: {
          items: await s.service.coverage(s.context, {
            kind: query.subjectKind,
            id: query.subjectId,
          }),
        },
      };
    },
    startReplenishment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.startReplenishment(
          s.context,
          params.definitionId,
          body,
        ),
      };
    },
    replenishmentReview: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.replenishmentReview(
          s.context,
          params.definitionId,
          params.runId,
        ),
      };
    },
    decideReplenishment: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.decideReplenishment(
          s.context,
          params.definitionId,
          params.runId,
          body,
        ),
      };
    },
    list: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: { items: await s.service.list(s.context) } };
    },
    detail: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.detail(s.context, params.definitionId),
      };
    },
    runs: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: { items: await s.service.runs(s.context, params.definitionId) },
      };
    },
    fire: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.fire(s.context, params.definitionId, body),
      };
    },
    cancelStart: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.cancelStart(
          s.context,
          params.definitionId,
          params.runId,
        ),
      };
    },
    activate: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.activate(s.context, params.definitionId, body),
      };
    },
    activateCase: async ({ request, params, body }) => {
      const s = use(request);
      const { id, version, reviewedDigest, policyVersion } = body;

      return {
        status: 200,
        body: await s.service.activateCase(s.context, params.definitionId, {
          id,
          version,
          reviewedDigest,
          policyVersion,
        }),
      };
    },
    revoke: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.revoke(
          s.context,
          params.definitionId,
          params.activationId,
          body.artifactDigest,
        ),
      };
    },
  });
}
