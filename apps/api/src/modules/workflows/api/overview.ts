import { initServer } from '@ts-rest/fastify';
import { apiContract, operationsOverviewSchema } from '@luma/api-contract';
import { IdentityError } from '#modules/identity/index';
import type { OperationsOverviewService } from '#modules/workflows/application/overview';
export function operationsRoutes(service?: OperationsOverviewService) {
  return initServer().router(apiContract.operations, {
    overview: async ({ request, query }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Operations overview is unavailable',
        );
      return {
        status: 200,
        body: operationsOverviewSchema.parse(
          await service(request.tenantContext, query.window),
        ),
      };
    },
  });
}
