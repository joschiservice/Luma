import '@luma/identity/http';

import {
  activityCountsSchema,
  activityExportSchema,
  activityPageSchema,
  apiContract,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { ActivityService } from '../application/activity.js';

/** Serves validated workspace history, its counts and exports with current membership. */
export function activityRoutes(service?: ActivityService) {
  const os = implement(apiContract.activity).$context<HttpContext>();
  const ready = (request: HttpContext['request']) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Activity is unavailable',
      );

    return { context: request.tenantContext, service };
  };

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        const { context, service } = ready(request);

        return activityPageSchema.parse(await service.list(context, query));
      },
    ),
    counts: os.counts.handler(
      async ({ context: { request }, input: { query } }) => {
        const { context, service } = ready(request);

        return activityCountsSchema.parse(
          await service.counts(context, { ...query, limit: 1 }),
        );
      },
    ),
    export: os.export.handler(
      async ({ context: { request }, input: { body } }) => {
        const { context, service } = ready(request);

        return activityExportSchema.parse(
          await service.export(context, body.query, {
            headings: body.headings,
            values: body.values,
            truncated: body.truncated,
          }),
        );
      },
    ),
  });
}
