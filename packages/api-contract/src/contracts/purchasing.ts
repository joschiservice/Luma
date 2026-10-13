import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  purchasingOverviewSchema,
  purchasingPlanInputSchema,
  purchasingPlanSchema,
  purchasingSettingsSchema,
} from '../purchasing.js';
import {
  purchasingIgnoreSchema,
  purchasingOutcomeListSchema,
} from '../purchasing-outcomes.js';

const path = '/v1/organizations/{organizationId}/procurement/purchasing';
const planParams = organizationParamsSchema.extend({
  planId: z.string().uuid(),
});
const read = {
  access: requires('procurement.read'),
  errors: [401, 403, 404, 409, 503],
} as const;
const write = {
  access: requires('procurement.manage'),
  errors: [401, 403, 404, 409, 503],
} as const;

export const purchasingContract = {
  purchasingOutcomes: endpoint
    .route({
      method: 'GET',
      path: `${path}/outcomes`,
      summary: 'Read evidence-backed purchasing outcomes',
      description:
        'Reports observed stockouts, stock availability through independently observed receipt, and explicit unknowns. No recommendation itself proves prevented loss.',
    })
    .meta(read)
    .input(z.object({ params: organizationParamsSchema }))
    .output(purchasingOutcomeListSchema),
  purchasingIgnore: endpoint
    .route({
      method: 'POST',
      path: `${path}/ignored`,
      summary: 'Record an ignored purchasing recommendation',
      description:
        'Captures the server recommendation and the person’s reason. Reuse the ID and body on retry.',
    })
    .meta(write)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: purchasingIgnoreSchema,
      }),
    )
    .output(z.object({ recorded: z.literal(true) })),
  purchasingOverview: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read explainable purchasing recommendations',
    })
    .meta(read)
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          demandPeriodDays: z.coerce.number().int().min(7).max(180).optional(),
        }),
      }),
    )
    .output(purchasingOverviewSchema),
  purchasingSettings: endpoint
    .route({
      method: 'PUT',
      path: `${path}/settings`,
      summary: 'Save purchasing assumptions',
      description:
        'Revision-checked workspace demand period, safety days and included locations. Missing inputs never authorize an order.',
    })
    .meta(write)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: purchasingSettingsSchema,
      }),
    )
    .output(purchasingSettingsSchema),
  purchasingPlans: endpoint
    .route({
      method: 'GET',
      path: `${path}/plans`,
      summary: 'List reviewed purchasing plans',
    })
    .meta(read)
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(purchasingPlanSchema) })),
  purchasingPlan: endpoint
    .route({
      method: 'POST',
      path: `${path}/plans`,
      summary: 'Propose one supplier purchase-order draft',
      description:
        'Persists chosen quantities beside the recommendation and requests governed approval. Retain the ID and body on retry. Submission is a separate action.',
    })
    .meta(write)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: purchasingPlanInputSchema,
      }),
    )
    .output(purchasingPlanSchema),
  purchasingDecision: endpoint
    .route({
      method: 'POST',
      path: `${path}/plans/{planId}/decision`,
      summary: 'Approve or reject a purchasing plan',
    })
    .meta(write)
    .input(
      z.object({
        params: planParams,
        body: z
          .object({
            decisionId: z.string().uuid(),
            outcome: z.enum(['approved', 'rejected']),
          })
          .strict(),
      }),
    )
    .output(purchasingPlanSchema),
  purchasingExecute: endpoint
    .route({
      method: 'POST',
      path: `${path}/plans/{planId}/execute`,
      summary: 'Create and independently verify an approved draft',
    })
    .meta(write)
    .input(z.object({ params: planParams, body: z.object({}).strict() }))
    .output(purchasingPlanSchema),
  purchasingReconcile: endpoint
    .route({
      method: 'POST',
      path: `${path}/plans/{planId}/check`,
      summary: 'Read to settle an uncertain draft creation',
      description: 'Only reconciles by reading; never creates another order.',
    })
    .meta(write)
    .input(z.object({ params: planParams, body: z.object({}).strict() }))
    .output(purchasingPlanSchema),
};
