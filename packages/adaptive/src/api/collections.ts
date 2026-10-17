import '@luma/identity/http';

import {
  apiContract,
  collectionMemberStateResponseSchema,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { invalid, ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { CollectionStates } from '../application/collection-states.js';
import type { ViewExports } from '../application/exports.js';

/** Serves each member's remembered list state through refreshed authorization. */
export function collectionRoutes(
  service?: CollectionStates,
  exports?: ViewExports,
) {
  const os = implement(apiContract.collections).$context<HttpContext>();

  function use(request: HttpContext['request']) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (!service) throw unavailable('List settings are unavailable.');

    return { service, context: request.tenantContext };
  }

  return os.router({
    state: os.state.handler(async ({ context: { request }, input }) => {
      const deps = use(request);

      return collectionMemberStateResponseSchema.parse(
        await deps.service.get(deps.context, input.params.domain),
      );
    }),
    saveState: os.saveState.handler(async ({ context: { request }, input }) => {
      const deps = use(request);

      return collectionMemberStateResponseSchema.parse(
        await deps.service.save(deps.context, input.params.domain, input.body),
      );
    }),
    resetState: os.resetState.handler(
      async ({ context: { request }, input }) => {
        const deps = use(request);

        return collectionMemberStateResponseSchema.parse(
          await deps.service.reset(deps.context, input.params.domain),
        );
      },
    ),
    export: os.export.handler(({ context: { request }, input }) => {
      if (!request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (!exports) throw unavailable('Exports are unavailable.');
      if (input.body.query.domain !== input.params.domain)
        throw invalid('The query belongs to another list.');

      return exports.export(
        request.tenantContext,
        input.body.query,
        input.body.labels,
      );
    }),
    resetAll: os.resetAll.handler(({ context: { request } }) => {
      const deps = use(request);

      return deps.service.resetAll(deps.context);
    }),
  });
}
