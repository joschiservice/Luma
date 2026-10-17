import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import { evidenceListSchema, evidenceRequestSchema } from '../evidence.js';

export const evidenceContract = {
  resolve: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/evidence/resolve',
      summary: 'Resolve the evidence a record cites',
      description:
        'Resolves the references a purchase order, return write, reply or case cites. Each reference is a stored provider read (source, record, read time, source update time and revision, completeness, adapter version and a normalized summary), a provider write receipt (capability, accepted time, provider records and request ID), a Luma record, `not_retained` when it was cited before Luma stored that kind of evidence, or `unresolved`. Without `refs`, resolves every reference the subject cites, up to 100. Needs the read permission of the subject: `procurement.read`, `returns.read`, `messages.read` or `issues.read`. Provider payloads and credentials are never returned.',
    })
    .meta({
      access: requires([
        'procurement.read',
        'returns.read',
        'messages.read',
        'issues.read',
      ]),
      errors: [401, 403, 404, 503],
      readOnly: true,
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: evidenceRequestSchema,
      }),
    )
    .output(evidenceListSchema),
};
