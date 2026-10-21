import '@luma/identity/http';

import { apiContract, changePageSchema } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { ChangeFeed } from '../application/changes.js';

/** Exposes the change feed of the record types the reader can read. */
export function changeRoutes(service?: ChangeFeed) {
  const os = implement(apiContract.changes).$context<HttpContext>();

  return os.router({
    list: os.list.handler(
      async ({ context: { request }, input: { query } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!service) throw unavailable('Changes are unavailable');

        return changePageSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
  });
}
