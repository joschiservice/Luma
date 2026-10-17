import { apiContract, salesOrderSchema } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { notFound, ServiceError } from '@luma/platform';
import { implement } from '@orpc/server';

import type { SalesService } from '../application/service.js';

/** Registers sales routes; unavailable release gates fail closed on every write. */
export function salesRoutes(service?: SalesService) {
  const os = implement(apiContract.sales).$context<HttpContext>();

  function current(context: HttpContext) {
    if (!context.request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service) throw notFound('Luma orders are unavailable');

    return { service, tenant: context.request.tenantContext };
  }

  return os.router({
    availability: os.availability.handler(async ({ context }) => {
      if (!context.request.tenantContext)
        throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return {
        enabled: service
          ? await service.enabled(context.request.tenantContext)
          : false,
      };
    }),
    get: os.get.handler(async ({ context, input }) => {
      const { service, tenant } = current(context);

      return salesOrderSchema
        .nullable()
        .parse(await service.get(tenant, input.params.orderId));
    }),
    accept: os.accept.handler(async ({ context, input }) => {
      const { service, tenant } = current(context);

      return salesOrderSchema.parse(
        await service.accept(
          tenant,
          input.params.orderId,
          input.body.connectionId,
        ),
      );
    }),
    edit: os.edit.handler(async ({ context, input }) => {
      const { service, tenant } = current(context);

      return salesOrderSchema.parse(
        await service.edit(tenant, input.params.orderId, input.body),
      );
    }),
  });
}
