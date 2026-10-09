import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { PlaybookLibrary } from '../application/playbook-library.js';

/** Registers tenant-authenticated playbook reads and permission-gated controls. */
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

  const os = implement(apiContract.playbooks).$context<HttpContext>();

  return os.router({
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
    activate: os.activate.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.activate(s.context, params.definitionId, body);
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
