import { apiContract } from '@luma/api-contract';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

/** Exposes release availability independently from action authorization. */
export function adaptiveAvailabilityRoutes(
  available?: (context: TenantContext) => Promise<{
    fields: boolean;
    views: boolean;
    generation: boolean;
    actions: boolean;
    packages: boolean;
  }>,
) {
  const os = implement(apiContract.adaptive).$context<HttpContext>();

  return os.router({
    availability: os.availability.handler(async ({ context: { request } }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

      return available
        ? available(request.tenantContext)
        : {
            fields: false,
            views: false,
            generation: false,
            actions: false,
            packages: false,
          };
    }),
  });
}
