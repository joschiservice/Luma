import { z } from 'zod';

import {
  adaptiveActionCatalogSchema,
  adaptiveActionDefinitionsSchema,
  adaptiveActionPreviewSchema,
  adaptiveActionRequestSchema,
  adaptiveActionResultsSchema,
} from '../adaptive-actions.js';
import { adaptiveViewDomainSchema } from '../adaptive-views.js';
import { anyMember, endpoint, organizationParamsSchema } from '../common.js';

const viewParams = organizationParamsSchema.extend({
  viewId: z.string().uuid(),
});
const params = viewParams.extend({ actionId: z.string().min(1).max(120) });
const path =
  '/v1/organizations/{organizationId}/adaptive/views/{viewId}/actions';

export const adaptiveActionsContract = {
  definitions: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/adaptive/action-definitions',
      summary: 'Read supported governed action mappings for this record type',
    })
    .meta({ access: anyMember, errors: [401, 403, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({ domain: adaptiveViewDomainSchema }),
      }),
    )
    .output(adaptiveActionDefinitionsSchema),
  catalog: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read governed actions available on a saved view',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: viewParams }))
    .output(adaptiveActionCatalogSchema),
  preview: endpoint
    .route({
      method: 'POST',
      path: `${path}/{actionId}/preview`,
      summary: 'Review each proposed record change before acting',
    })
    .meta({
      access: anyMember,
      readOnly: true,
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params, body: adaptiveActionRequestSchema }))
    .output(adaptiveActionPreviewSchema),
  run: endpoint
    .route({
      method: 'POST',
      path: `${path}/{actionId}/run`,
      summary: 'Propose separately governed commands for selected records',
      description:
        'Rechecks current authorization and the reviewed change. Commands retain owner policy, approval, idempotency and independent verification. Each selected record returns its own result.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(
      z.object({
        params,
        body: adaptiveActionRequestSchema.extend({
          reviewDigest: z.string().min(1).max(128),
        }),
      }),
    )
    .output(adaptiveActionResultsSchema),
};
