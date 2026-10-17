import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { AdaptiveViews } from '../application/views.js';

/** Serves reviewed query definitions through refreshed service authorization. */
export function viewsRoutes(service?: AdaptiveViews) {
  const os = implement(apiContract.adaptiveViews).$context<HttpContext>();

  function use(request: HttpContext['request']) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service) throw unavailable('Saved views are unavailable.');

    return { service, context: request.tenantContext };
  }

  return os.router({
    list: os.list.handler(({ context: { request } }) => {
      const deps = use(request);

      return deps.service.list(deps.context);
    }),
    get: os.get.handler(({ context: { request }, input: { params } }) => {
      const deps = use(request);

      return deps.service.get(deps.context, params.viewId);
    }),
    create: os.create.handler(({ context: { request }, input: { body } }) => {
      const deps = use(request);

      return deps.service.create(deps.context, body);
    }),
    update: os.update.handler(
      ({ context: { request }, input: { params, body } }) => {
        const deps = use(request);

        return deps.service.update(deps.context, params.viewId, body);
      },
    ),
    archive: os.archive.handler(
      ({ context: { request }, input: { params, body } }) => {
        const deps = use(request);

        return deps.service.archive(
          deps.context,
          params.viewId,
          body.expectedRevision,
        );
      },
    ),
    duplicate: os.duplicate.handler(
      ({ context: { request }, input: { params, body } }) => {
        const deps = use(request);

        return deps.service.duplicate(
          deps.context,
          params.viewId,
          body.name,
          body.commandId,
        );
      },
    ),
    history: os.history.handler(
      ({ context: { request }, input: { params } }) => {
        const deps = use(request);

        return deps.service.history(deps.context, params.viewId);
      },
    ),
    preview: os.preview.handler(({ context: { request }, input: { body } }) => {
      const deps = use(request);

      return deps.service.preview(
        deps.context,
        body.query,
        body.cursor,
        body.selectedRecordIds,
      );
    }),
    generate: os.generate.handler(
      ({ context: { request }, input: { body } }) => {
        const deps = use(request);

        return deps.service.generate(deps.context, body.prompt);
      },
    ),
  });
}
