import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
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

  const os = implement(apiContract.workflows).$context<HttpContext>();

  return os.router({
    evaluateCode: os.evaluateCode.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.evaluateCode(
          s.context,
          params.definitionId,
          body,
        );
      },
    ),
    codeEvaluation: os.codeEvaluation.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.codeEvaluation(
          s.context,
          params.definitionId,
          params.evaluationId,
        );
      },
    ),
    cancelCodeEvaluation: os.cancelCodeEvaluation.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.cancelCodeEvaluation(
          s.context,
          params.definitionId,
          params.evaluationId,
        );
      },
    ),
    cancelCodeStep: os.cancelCodeStep.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.cancelCodeStep(
          s.context,
          params.definitionId,
          params.runId,
          params.stepId,
        );
      },
    ),
    replenishmentSetup: os.replenishmentSetup.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return await s.service.replenishmentSetup(
          s.context,
          params.definitionId,
          query,
        );
      },
    ),
    configureReplenishment: os.configureReplenishment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.configureReplenishment(
          s.context,
          params.definitionId,
          body,
        );
      },
    ),
    previewReplenishment: os.previewReplenishment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.previewReplenishment(
          s.context,
          params.definitionId,
          body,
        );
      },
    ),
    configureReplenishmentBatch: os.configureReplenishmentBatch.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return {
          results: await s.service.configureReplenishmentMany(
            s.context,
            params.definitionId,
            body.items,
          ),
        };
      },
    ),
    coverage: os.coverage.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);

        return {
          items: await s.service.coverage(s.context, {
            kind: query.subjectKind,
            id: query.subjectId,
          }),
        };
      },
    ),
    startReplenishment: os.startReplenishment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.startReplenishment(
          s.context,
          params.definitionId,
          body,
        );
      },
    ),
    replenishmentReview: os.replenishmentReview.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.replenishmentReview(
          s.context,
          params.definitionId,
          params.runId,
        );
      },
    ),
    decideReplenishment: os.decideReplenishment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.decideReplenishment(
          s.context,
          params.definitionId,
          params.runId,
          body,
        );
      },
    ),
    list: os.list.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.service.list(s.context) };
    }),
    detail: os.detail.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.detail(s.context, params.definitionId);
      },
    ),
    runs: os.runs.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return { items: await s.service.runs(s.context, params.definitionId) };
      },
    ),
    fire: os.fire.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.fire(s.context, params.definitionId, body);
      },
    ),
    cancelStart: os.cancelStart.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.cancelStart(
          s.context,
          params.definitionId,
          params.runId,
        );
      },
    ),
    activate: os.activate.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.activate(s.context, params.definitionId, body);
      },
    ),
    activateCase: os.activateCase.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);
        const { id, version, reviewedDigest, policyVersion } = body;

        return await s.service.activateCase(s.context, params.definitionId, {
          id,
          version,
          reviewedDigest,
          policyVersion,
        });
      },
    ),
    revoke: os.revoke.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.revoke(
          s.context,
          params.definitionId,
          params.activationId,
          body.artifactDigest,
        );
      },
    ),
  });
}
