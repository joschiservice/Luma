import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
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

  const os = implement(apiContract.workflowDrafts).$context<HttpContext>();

  return os.router({
    templates: os.templates.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.templates.list(s.context) };
    }),
    installTemplate: os.installTemplate.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.templates.install(s.context, params.templateId);
      },
    ),
    vocabulary: os.vocabulary.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.vocabulary(s.context);
    }),
    validate: os.validate.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.validate(s.context, body);
      },
    ),
    list: os.list.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.service.list(s.context) };
    }),
    create: os.create.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.create(s.context, body);
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      const s = use(request);

      return await s.service.get(s.context, params.draftId);
    }),
    save: os.save.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.save(s.context, params.draftId, body);
      },
    ),
    publish: os.publish.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);
        const result = await s.service.publish(s.context, params.draftId, body);

        return {
          draft: result.draft,
          version: {
            definitionId: result.version.definition.id,
            version: result.version.version,
            digest: result.version.digest,
          },
        };
      },
    ),
    discard: os.discard.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.discard(s.context, params.draftId, body);
      },
    ),
  });
}
