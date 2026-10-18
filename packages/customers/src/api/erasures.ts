import '@luma/identity/http';

import { apiContract, customerErasureSchema } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { CustomerErasure } from '../application/erasure.js';

/** Serves data-subject erasures to members with `customers.erase`. */
export function customerErasureRoutes(service?: CustomerErasure) {
  const os = implement(apiContract.customerErasures).$context<HttpContext>();

  function current(request: HttpContext['request']) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Customer erasure is unavailable',
      );

    return { service, tenant: request.tenantContext };
  }

  return os.router({
    preview: os.preview.handler(
      async ({ context: { request }, input: { body } }) => {
        const { service, tenant } = current(request);
        const result = await service.preview(tenant, body);
        if (!result)
          throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');

        return customerErasureSchema.parse(result);
      },
    ),
    create: os.create.handler(
      async ({ context: { request }, input: { body } }) => {
        const { service, tenant } = current(request);
        const result = await service.erase(tenant, body);
        if (!result)
          throw new IdentityError(404, 'NOT_FOUND', 'Connection not found');

        return customerErasureSchema.parse(result);
      },
    ),
  });
}
