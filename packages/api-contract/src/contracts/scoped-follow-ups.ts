import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  refreshFollowUpSchema,
  scopedFollowUpsSchema,
} from '../scoped-autonomy.js';

const params = organizationParamsSchema.extend({
  proposalId: z.string().uuid(),
});
const path = '/v1/organizations/{organizationId}/autonomy/follow-ups';
const errors = [400, 401, 403, 404, 409, 422, 503] as const;

/** Reviews and renews the first bounded internal responsibility without carrying old approval forward. */
export const scopedFollowUpsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Review governed supplier follow-up notes',
      description:
        'Lists immutable note proposals and current policy decisions. Approval only records consent; a note counts as recorded after a fresh independent owner read.',
    })
    .meta({ access: requires('procurement.manage'), errors })
    .input(z.object({ params: organizationParamsSchema }))
    .output(scopedFollowUpsSchema),
  respond: endpoint
    .route({
      method: 'POST',
      path: `${path}/{proposalId}/response`,
      summary: 'Respond to a governed follow-up proposal',
      description:
        'Requires procurement management and decision response authority. Checks the exact current decision, requester independence, original workflow, current order, evidence and policy. Does not execute the note.',
    })
    .meta({ access: requires('decisions.respond'), errors })
    .input(
      z.object({
        params,
        body: z
          .object({
            decisionId: z.string().uuid(),
            outcome: z.enum(['approved', 'rejected']),
          })
          .strict(),
      }),
    )
    .output(
      z.object({
        proposalId: z.string().uuid(),
        outcome: z.enum(['approved', 'rejected']),
      }),
    ),
  reconcile: endpoint
    .route({
      method: 'POST',
      path: `${path}/{proposalId}/reconcile`,
      summary: 'Verify a reserved or uncertain follow-up note',
      description:
        'Performs independent owner verification of an existing attempt. It never dispatches another note and remains available while new scoped work is paused.',
    })
    .meta({ access: requires('procurement.manage'), errors })
    .input(z.object({ params }))
    .output(z.object({ proposalId: z.string().uuid() })),
  refresh: endpoint
    .route({
      method: 'POST',
      path: `${path}/{proposalId}/refresh`,
      summary: 'Refresh a stale follow-up proposal for a new decision',
      description:
        'The original workflow requester rereads current order facts and explicitly binds a successor immutable proposal and execution step. The previous approval never transfers. The logical note receipt stays the same. Reserved, dispatched or uncertain attempts must reconcile first.',
    })
    .meta({ access: requires('procurement.manage'), errors })
    .input(
      z.object({
        params,
        body: z.object({ commandId: z.string().uuid() }).strict(),
      }),
    )
    .output(refreshFollowUpSchema),
};
