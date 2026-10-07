import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { caseEvidenceQuerySchema } from '../cases.js';
import { apiErrorSchema, caseParams, requires } from '../common.js';
import {
  caseDecisionSchema,
  caseProgressSchema,
  caseReviewSchema,
  caseTimelineSchema,
  decisionReceiptSchema,
} from '../desk.js';

const c = initContract();

export const caseDeskContract = c.router(
  {
    review: {
      method: 'GET',
      metadata: requires('issues.read'),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/review',
      pathParams: caseParams,
      responses: { 200: caseReviewSchema },
      summary: 'Review a case proposal',
      description:
        'Returns an immutable proposal, its current policy result and permitted decisions. Unavailable capabilities cannot be approved. Manual recommendations remain in the case investigation.',
    },
    refresh: {
      method: 'POST',
      metadata: requires('actions.propose'),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/review/refresh',
      pathParams: caseParams,
      body: z.object({}).strict(),
      responses: { 200: caseReviewSchema },
      summary: 'Check current facts for a resolution proposal',
      description:
        'Checks current source facts and prepares a current proposal where supported. Existing approvals and execution records are preserved. Changed conditions require review; provider unavailability can be retried.',
    },
    decide: {
      method: 'POST',
      metadata: requires(['decisions.respond', 'issues.manage']),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/decisions',
      pathParams: caseParams,
      body: caseDecisionSchema,
      responses: { 200: decisionReceiptSchema },
      summary: 'Approve, reject or escalate a case',
      description:
        'Use a unique commandId and the current case, diagnosis, proposal and policy versions from review. Exact retries return the committed receipt. Conflicts return 409. Approval records a decision; it does not mean execution or verification succeeded.',
    },
    receipt: {
      method: 'GET',
      metadata: requires('issues.read'),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/decisions/:commandId',
      pathParams: caseParams.extend({ commandId: z.string().uuid() }),
      responses: { 200: decisionReceiptSchema },
      summary: 'Recover a decision result',
      description:
        'After a timeout, read the receipt using the original command ID or retry the identical request. Receipts are visible to their submitting actor.',
    },
    progress: {
      method: 'GET',
      metadata: requires('issues.read'),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/progress',
      pathParams: caseParams,
      responses: { 200: caseProgressSchema },
      summary: 'Read execution and verification progress',
      description:
        'Returns persisted execution and canonical resolution separately from workflow phase. An unavailable workflow service does not imply success or no activity.',
    },
    timeline: {
      method: 'GET',
      metadata: requires('issues.read'),
      path: '/v1/organizations/:organizationId/exceptions/:exceptionId/timeline',
      pathParams: caseParams,
      query: caseEvidenceQuerySchema,
      responses: { 200: caseTimelineSchema },
      summary: 'Read case audit history',
      description:
        'Returns up to 100 persisted events, ordered by timestamp and ID. Reuse cursors with the same organization, case and page size. Refresh from the first page and deduplicate by ID as events arrive.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
