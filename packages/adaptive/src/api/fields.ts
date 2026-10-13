import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { AdaptiveFields } from '../application/fields.js';
import type { FieldWorkflowAdapter } from '../application/fields-workflows.js';

/** Registers authenticated custom field definitions, values, queries and immutable history. */
export function fieldsRoutes(
  service?: AdaptiveFields,
  workflows?: FieldWorkflowAdapter,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Custom fields are unavailable.',
      );

    return { service, context: request.tenantContext };
  }

  const os = implement(apiContract.adaptiveFields).$context<HttpContext>();

  return os.router({
    workflowPending: os.workflowPending.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);
        if (!workflows)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Custom field workflows are unavailable.',
          );

        return (await workflows.pending(s.context)).filter(
          (item) =>
            (!query.recordType || item.recordType === query.recordType) &&
            (!query.recordId || item.recordId === query.recordId),
        );
      },
    ),
    workflowReview: os.workflowReview.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);
        if (!workflows)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Custom field workflows are unavailable.',
          );

        return workflows.review(s.context, params.runId, params.stepId);
      },
    ),
    workflowDecide: os.workflowDecide.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);
        if (!workflows)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Custom field workflows are unavailable.',
          );

        return workflows.respond(s.context, params.runId, params.stepId, body);
      },
    ),
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);

        return s.service.list(
          s.context,
          query.recordType,
          query.includeArchived,
        );
      },
    ),
    create: os.create.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return s.service.create(s.context, body);
      },
    ),
    update: os.update.handler(
      async ({ context: { request }, input: { body, params } }) => {
        const s = use(request);

        return s.service.update(s.context, params.fieldId, body);
      },
    ),
    restore: os.restore.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.restore(s.context, params.fieldId, body.revision);
      },
    ),
    archive: os.archive.handler(
      async ({ context: { request }, input: { body, params } }) => {
        const s = use(request);

        return s.service.archive(s.context, params.fieldId, body.revision);
      },
    ),
    readValues: os.readValues.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.readValues(
          s.context,
          params.recordType,
          params.recordId,
        );
      },
    ),
    writeValues: os.writeValues.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.writeValues(
          s.context,
          params.recordType,
          params.recordId,
          body.values,
        );
      },
    ),
    query: os.query.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return s.service.query(s.context, body);
      },
    ),
    history: os.history.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return s.service.history(
          s.context,
          params.fieldId,
          query.recordId ?? null,
        );
      },
    ),
  });
}
