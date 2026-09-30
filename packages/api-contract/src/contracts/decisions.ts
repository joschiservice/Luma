import { initContract } from '@ts-rest/core';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  decisionAssignInputSchema,
  decisionAssignResultSchema,
  decisionListSchema,
  decisionQuerySchema,
} from '../decisions.js';

const c = initContract();

export const decisionsContract = c.router({
  list: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/decisions',
    pathParams: organizationParamsSchema,
    query: decisionQuerySchema,
    responses: {
      200: decisionListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'List decisions that need a person',
    description:
      'List the workspace decisions waiting on a person: issue approvals, manual steps and uncertainty, replenishment purchase-order approvals, and app-owned stock corrections and fulfillment recoveries. Each item explains why a person is needed, what each response causes, the exact proposed change, evidence freshness and the deadline after which the proposal loses its authority. Items are projections of their owners’ decisions: respond through the owner’s review, which checks the exact proposal, revisions, expiry and approver again. Items sort by urgency (proposals expiring within 30 minutes, then high impact, then the rest), then by deadline, oldest request and ID. Unknown impact is labeled, not ranked low. `response` says what the reader can do; members see decisions but cannot approve. `sources` reports owners that failed to answer; their decisions are missing rather than resolved. Results contain up to `limit` items (at most 100); nextCursor continues the same view and filters. An empty queue does not mean operations are healthy.',
  },
  assign: {
    method: 'POST',
    path: '/v1/organizations/:organizationId/decisions/assignments',
    pathParams: organizationParamsSchema,
    body: decisionAssignInputSchema,
    responses: {
      200: decisionAssignResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Assign a decision',
    description:
      'Take, hand over or release a decision in the Needs you queue. Any member can take an unassigned decision or release their own; owners and admins can assign any decision to a current member. Send the `revision` from the item’s assignment (0 when unassigned); a changed assignment returns 409. The decision must currently need a person. Assigning does not grant approval authority: the owner still checks roles and requires an approver different from the requester.',
  },
});
