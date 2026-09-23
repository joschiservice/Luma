import { activityPageSchema, apiContract } from '@luma/api-contract';
import { initServer } from '@ts-rest/fastify';

import { IdentityError } from '#modules/identity/index';
import type { ActivityService } from '#modules/workflows/application/activity';

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
