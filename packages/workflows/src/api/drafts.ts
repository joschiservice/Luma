import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';

import type { WorkflowDrafts } from '../application/drafts.js';
import type { WorkflowTemplates } from '../application/templates.js';

/** Registers tenant-authenticated templates, draft authoring, validation and publication routes. */
export function workflowDraftRoutes(
  service?: WorkflowDrafts,
  templates?: WorkflowTemplates,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service || !templates)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Workflow authoring is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service, templates };
  }

  return initServer().router(apiContract.workflowDrafts, {
    templates: async ({ request }) => {
      const s = use(request);

      return {
        status: 200,
        body: { items: await s.templates.list(s.context) },
      };
    },
    installTemplate: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.templates.install(s.context, params.templateId),
      };
    },
    vocabulary: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: await s.service.vocabulary(s.context) };
    },
    validate: async ({ request, body }) => {
      const s = use(request);

      return { status: 200, body: await s.service.validate(s.context, body) };
    },
    list: async ({ request }) => {
      const s = use(request);

      return { status: 200, body: { items: await s.service.list(s.context) } };
    },
    create: async ({ request, body }) => {
      const s = use(request);

      return { status: 200, body: await s.service.create(s.context, body) };
    },
    get: async ({ request, params }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.get(s.context, params.draftId),
      };
    },
    save: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.save(s.context, params.draftId, body),
      };
    },
    publish: async ({ request, params, body }) => {
      const s = use(request);
      const result = await s.service.publish(s.context, params.draftId, body);

      return {
        status: 200,
        body: {
          draft: result.draft,
          version: {
            definitionId: result.version.definition.id,
            version: result.version.version,
            digest: result.version.digest,
          },
        },
      };
    },
    discard: async ({ request, params, body }) => {
      const s = use(request);

      return {
        status: 200,
        body: await s.service.discard(s.context, params.draftId, body),
      };
    },
  });
}
