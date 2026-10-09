import '@luma/identity/http';

import { activityPageSchema, apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { ActivityService } from '../application/activity.js';

/** Serves validated workspace history with current membership and bounded filters. */
export function activityRoutes(service?: ActivityService) {
  const os = implement(apiContract.activity).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        if (!service)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Activity is unavailable',
          );

        return activityPageSchema.parse(
          await service(request.tenantContext, query),
        );
      },
    ),
  });
}
