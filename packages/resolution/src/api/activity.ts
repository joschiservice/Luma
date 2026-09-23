import '@luma/identity/http';

import { activityPageSchema, apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import { initServer } from '@ts-rest/fastify';

import type { ActivityService } from '../application/activity.js';

/** Serves validated workspace history with current membership and bounded filters. */
export function activityRoutes(service?: ActivityService) {
  return initServer().router(apiContract.activity, {
    list: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Activity is unavailable',
        );

      return {
        status: 200,
        body: activityPageSchema.parse(
          await service(request.tenantContext, query),
        ),
      };
    },
  });
}
