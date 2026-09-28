import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { codeEvaluationSchema, evaluateCodeSchema } from '../code-steps.js';
import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  replenishmentReviewSchema,
  replenishmentRuleSchema,
  replenishmentSetupSchema,
} from '../replenishment.js';
import {
  activateWorkflowSchema,
  fireWorkflowSchema,
  workflowActivationSchema,
  workflowDetailSchema,
  workflowRunViewSchema,
  workflowSummarySchema,
} from '../workflows.js';

const c = initContract();
const params = organizationParamsSchema.extend({
  definitionId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
});
const path = '/v1/organizations/:organizationId/workflows';

export const workflowsContract = c.router(
  {
    evaluateCode: {
      method: 'POST',
      path: `${path}/:definitionId/code-evaluations`,
      pathParams: params,
      body: evaluateCodeSchema,
      responses: { 200: codeEvaluationSchema },
      summary: 'Evaluate a published Code Step',
      description:
        'Owners and admins test an exact version with example inputs, capability replies and expected outputs. Evaluation does not call connected systems. Reuse the same ID and body after an uncertain response.',
    },
    codeEvaluation: {
      method: 'GET',
      path: `${path}/:definitionId/code-evaluations/:evaluationId`,
      pathParams: params.extend({ evaluationId: z.string().uuid() }),
      responses: { 200: codeEvaluationSchema },
      summary: 'Read a Code Step evaluation',
    },
    cancelCodeEvaluation: {
      method: 'POST',
      path: `${path}/:definitionId/code-evaluations/:evaluationId/cancel`,
      pathParams: params.extend({ evaluationId: z.string().uuid() }),
      body: z.object({}).strict(),
      responses: { 200: codeEvaluationSchema },
      summary: 'Cancel a running Code Step evaluation',
    },
    cancelCodeStep: {
      method: 'POST',
      path: `${path}/:definitionId/runs/:runId/code/:stepId/cancel`,
      pathParams: params.extend({
        runId: z.string().uuid(),
        stepId: z.string().max(80),
      }),
      body: z.object({}).strict(),
      responses: { 200: z.object({ cancelled: z.literal(true) }) },
      summary: 'Stop a Code Step',
      description:
        'Stops computation and prevents new capability requests. Actions already admitted may still complete and require reconciliation.',
    },
    replenishmentSetup: {
      method: 'GET',
      path: `${path}/:definitionId/replenishment`,
      pathParams: params,
      responses: { 200: replenishmentSetupSchema },
      summary: 'Read replenishment scopes and current stock',
    },
    configureReplenishment: {
      method: 'POST',
      path: `${path}/:definitionId/replenishment/activations`,
      pathParams: params,
      body: replenishmentRuleSchema,
      responses: { 200: workflowActivationSchema },
      summary: 'Activate a replenishment rule',
      description:
        'Owners and admins review a stock position, supplier and quantity limits. Target stock must exceed the minimum. Reuse the exact ID and body when retrying.',
    },
    startReplenishment: {
      method: 'POST',
      path: `${path}/:definitionId/replenishment/starts`,
      pathParams: params,
      body: z
        .object({ id: z.string().uuid(), activationId: z.string().uuid() })
        .strict(),
      responses: { 200: workflowRunViewSchema },
      summary: 'Check low stock and start replenishment',
      description:
        'Reads current stock on the server and starts the activated version when stock is below its minimum. Reuse the request ID after an uncertain response.',
    },
    replenishmentReview: {
      method: 'GET',
      path: `${path}/:definitionId/replenishment/runs/:runId`,
      pathParams: params.extend({ runId: z.string().uuid() }),
      responses: { 200: replenishmentReviewSchema },
      summary: 'Review a replenishment proposal',
    },
    decideReplenishment: {
      method: 'POST',
      path: `${path}/:definitionId/replenishment/runs/:runId/decision`,
      pathParams: params.extend({ runId: z.string().uuid() }),
      body: z
        .object({
          decisionId: z.string().uuid(),
          outcome: z.enum(['approved', 'rejected']),
        })
        .strict(),
      responses: { 200: replenishmentReviewSchema },
      summary: 'Approve or reject a replenishment proposal',
      description:
        'A different owner or admin decides on the exact proposal. Current stock, activation and policy are checked again before creating the order.',
    },
    list: {
      method: 'GET',
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(workflowSummarySchema) }) },
      summary: 'List workspace workflows',
      description:
        'Members can inspect published versions and activation status. Viewing a workflow never activates it.',
    },
    detail: {
      method: 'GET',
      path: `${path}/:definitionId`,
      pathParams: params,
      responses: { 200: workflowDetailSchema },
      summary: 'Inspect a workflow',
      description:
        'Read published steps, versions, prerequisites and historical grants. Process versions show the exact order of decisions, actions, waits and verification.',
    },
    runs: {
      method: 'GET',
      path: `${path}/:definitionId/runs`,
      pathParams: params,
      responses: { 200: z.object({ items: z.array(workflowRunViewSchema) }) },
      summary: 'Read recent workflow runs',
      description:
        'Returns the 50 most recent runs with subject, actor, trigger and step evidence. Process runs show their current state and recorded outputs. Execution and verification results are separate.',
    },
    fire: {
      method: 'POST',
      path: `${path}/:definitionId/starts`,
      pathParams: params,
      body: fireWorkflowSchema,
      responses: { 200: workflowRunViewSchema },
      summary: 'Start or schedule a workflow run',
      description:
        'Owners and admins submit typed signal evidence for an exact version and resource. Reuse the source ID and complete body on retry. Starts do not grant execution authority. Schedules start once at the time specified by the version.',
    },
    cancelStart: {
      method: 'POST',
      path: `${path}/:definitionId/starts/:runId/cancel`,
      pathParams: params.extend({ runId: z.string().uuid() }),
      body: z.object({}).strict(),
      responses: { 200: workflowRunViewSchema },
      summary: 'Cancel a pending scheduled start',
    },
    activate: {
      method: 'POST',
      path: `${path}/:definitionId/activations`,
      pathParams: params,
      body: activateWorkflowSchema,
      responses: { 200: workflowActivationSchema },
      summary: 'Activate a reviewed version',
      description:
        'Owners and admins can activate supported Resolution versions for their own principal and explicit orders on one connection. Other definitions remain available for review. Review the exact digest, scope and approval behavior. Reuse the same ID and body after an uncertain response. Conflicting, overlapping or stale grants return 409; revoked records cannot be restored.',
    },
    revoke: {
      method: 'POST',
      path: `${path}/:definitionId/activations/:activationId/revoke`,
      pathParams: params.extend({ activationId: z.string().uuid() }),
      body: z
        .object({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      responses: { 200: workflowActivationSchema },
      summary: 'Revoke a workflow activation',
      description:
        'Owners and admins prevent future admission under this artifact. Repeated revocation is safe. Revocation preserves historical grants and does not undo already-dispatched work.',
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
