import '@luma/identity/http';

import { apiContract, evidenceListSchema } from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';

import type { EvidenceReader } from '../application/evidence.js';

/** Resolves the evidence a purchase order, return write, reply or case cites. */
export function evidenceRoutes(reader?: EvidenceReader) {
  const os = implement(apiContract.evidence).$context<HttpContext>();

  return os.router({
    resolve: os.resolve.handler(
      async ({ context: { request }, input: { body } }) => {
        if (!request.tenantContext)
          throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
        if (!reader) throw unavailable('Evidence is unavailable');

        return evidenceListSchema.parse(
          await reader.resolve(request.tenantContext, body),
        );
      },
    ),
  });
}
