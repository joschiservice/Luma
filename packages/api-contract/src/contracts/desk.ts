import { z } from 'zod';

import { caseEvidenceQuerySchema } from '../cases.js';
import { caseParams, endpoint, requires } from '../common.js';
import {
  caseDecisionSchema,
  caseProgressSchema,
  caseReviewSchema,
  caseTimelineSchema,
  decisionReceiptSchema,
} from '../desk.js';

export const caseDeskContract = {
  review: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/review',
      summary: 'Review a case proposal',
      description:
        'Returns an immutable proposal, its current policy result and permitted decisions. Unavailable capabilities cannot be approved. Manual recommendations remain in the case investigation.',
    })
    .meta({
      access: requires('issues.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams }))
    .output(caseReviewSchema),
  refresh: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/review/refresh',
      summary: 'Check current facts for a resolution proposal',
      description:
        'Checks current source facts and prepares a current proposal where supported. Existing approvals and execution records are preserved. Changed conditions require review; provider unavailability can be retried.',
    })
    .meta({
      access: requires('actions.propose'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, body: z.object({}).strict() }))
    .output(caseReviewSchema),
  decide: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/decisions',
      summary: 'Approve, reject or escalate a case',
      description:
        'Use a unique commandId and the current case, diagnosis, proposal and policy versions from review. Exact retries return the committed receipt. Conflicts return 409. Approval records a decision; it does not mean execution or verification succeeded.',
    })
    .meta({
      access: requires(['decisions.respond', 'issues.manage']),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, body: caseDecisionSchema }))
    .output(decisionReceiptSchema),
  receipt: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/decisions/{commandId}',
      summary: 'Recover a decision result',
      description:
        'After a timeout, read the receipt using the original command ID or retry the identical request. Receipts are visible to their submitting actor.',
    })
    .meta({
      access: requires('issues.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: caseParams.extend({ commandId: z.string().uuid() }) }),
    )
    .output(decisionReceiptSchema),
  progress: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/progress',
      summary: 'Read execution and verification progress',
      description:
        'Returns persisted execution and canonical resolution separately from workflow phase. An unavailable workflow service does not imply success or no activity.',
    })
    .meta({
      access: requires('issues.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams }))
    .output(caseProgressSchema),
  timeline: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/exceptions/{exceptionId}/timeline',
      summary: 'Read case audit history',
      description:
        'Returns up to 100 persisted events, ordered by timestamp and ID. Reuse cursors with the same organization, case and page size. Refresh from the first page and deduplicate by ID as events arrive.',
    })
    .meta({
      access: requires('issues.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: caseParams, query: caseEvidenceQuerySchema }))
    .output(caseTimelineSchema),
};
