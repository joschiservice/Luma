import { apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import { IdentityError } from '#modules/identity/index';
import type { PlaybookLibrary } from '#modules/workflows/application/playbook-library';

/** Registers tenant-authenticated playbook reads and administrator controls. */
export function playbookRoutes(service?: PlaybookLibrary) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Playbooks are unavailable. Try again later.',
      );

    return { context: request.tenantContext, service };
  }

  return initServer().router(apiContract.playbooks, {
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
    activate: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.activate(s.context, params.definitionId, body),
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
