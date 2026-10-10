import { z } from 'zod';

import {
  authorityChangeSchema,
  authorityEventSchema,
  authoritySnapshotSchema,
} from '../authority.js';
import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';

export const sourceAuthorityContract = {
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/source-authority',
      summary: 'Read source authority',
      description:
        'Returns the authoritative connection for each order and inventory fact group. Unknown or conflicting authority cannot authorize a correction.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(authoritySnapshotSchema),
  change: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/source-authority',
      summary: 'Change source authority',
      description:
        'Overrides one fact group or restores its category default with a null connectionId. Requires workspace settings permission, the current revision and a stable commandId for retries. Each change records its actor and before/after override without changing source evidence.',
    })
    .meta({
      access: requires('workspace.settings.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: authorityChangeSchema,
      }),
    )
    .output(authorityEventSchema),
  history: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/source-authority/history',
      summary: 'Review source authority changes',
      description:
        'Returns the latest 100 changes, newest first, including the actor and previous and new overrides.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(authorityEventSchema) })),
};
