import '@luma/identity/http';

import {
  apiContract,
  recordDetailSchema,
  recordListSchema,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';

import type { RecordExplorer } from '../application/records.js';

/** Exposes record search and detail reads for the record kinds the reader may read. */
export function recordRoutes(service?: RecordExplorer) {
  const os = implement(apiContract.records).$context<HttpContext>();

  return os.router({
    resolve: os.resolve.handler(
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
            'Record mapping is unavailable',
          );

        return await service.resolve(request.tenantContext, query);
      },
    ),
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
            'Record search is unavailable',
          );

        return recordListSchema.parse(
          await service.list(request.tenantContext, query),
        );
      },
    ),
    get: os.get.handler(async ({ context: { request }, input: { params } }) => {
      if (!request.tenantContext)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
      if (!service)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Record details are unavailable',
        );
      const detail = await service.get(
        request.tenantContext,
        params.kind,
        params.recordId,
      );
      if (!detail)
        throw new IdentityError(404, 'NOT_FOUND', 'Record not found');

      return recordDetailSchema.parse(detail);
    }),
  });
}
