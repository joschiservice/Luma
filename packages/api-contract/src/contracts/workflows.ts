import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { codeEvaluationSchema, evaluateCodeSchema } from '../code-steps.js';
import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  replenishmentBatchRequestSchema,
  replenishmentBatchResultSchema,
  replenishmentPositionQuerySchema,
  replenishmentPreviewRequestSchema,
  replenishmentPreviewSchema,
  replenishmentReviewSchema,
  replenishmentRuleSchema,
  replenishmentSetupSchema,
  workflowCoverageSchema,
} from '../replenishment.js';
import {
  activateCaseWorkflowSchema,
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
      metadata: requires('workflows.author'),
      path: `${path}/:definitionId/code-evaluations`,
      pathParams: params,
      body: evaluateCodeSchema,
      responses: { 200: codeEvaluationSchema },
      summary: 'Evaluate a published Code Step',
      description:
        'Requires `workflows.author`. Tests an exact version with example inputs, capability replies and expected outputs. Evaluation does not call connected systems. Reuse the same ID and body after an uncertain response.',
    },
    codeEvaluation: {
      method: 'GET',
      metadata: requires('workflows.author'),
      path: `${path}/:definitionId/code-evaluations/:evaluationId`,
      pathParams: params.extend({ evaluationId: z.string().uuid() }),
      responses: { 200: codeEvaluationSchema },
      summary: 'Read a Code Step evaluation',
    },
    cancelCodeEvaluation: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: `${path}/:definitionId/code-evaluations/:evaluationId/cancel`,
      pathParams: params.extend({ evaluationId: z.string().uuid() }),
      body: z.object({}).strict(),
      responses: { 200: codeEvaluationSchema },
      summary: 'Cancel a running Code Step evaluation',
    },
    cancelCodeStep: {
      method: 'POST',
      metadata: requires('workflows.triggers.manage'),
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
      metadata: requires('procurement.read'),
      path: `${path}/:definitionId/replenishment`,
      pathParams: params,
      query: replenishmentPositionQuerySchema,
      responses: { 200: replenishmentSetupSchema },
      summary: 'Read replenishment rules and a page of stock choices',
      description:
        'Returns up to 50 stock choices. Search by SKU or filter to a position or connection. Continue with nextCursor and the same filters. Rule readiness includes the current stock for every configured rule, independently of this page.',
    },
    configureReplenishment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/:definitionId/replenishment/activations`,
      pathParams: params,
      body: replenishmentRuleSchema,
      responses: { 200: workflowActivationSchema },
      summary: 'Activate a replenishment rule',
      description:
        'Requires `procurement.manage`. Reviews a stock position, supplier and quantity limits. Target stock must exceed the minimum. Reuse the exact ID and body when retrying.',
    },
    previewReplenishment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/:definitionId/replenishment/previews`,
      pathParams: params,
      body: replenishmentPreviewRequestSchema,
      responses: { 200: replenishmentPreviewSchema },
      summary: 'Preview replenishment rules',
      description:
        'Requires `procurement.manage`. Checks up to 25 stock positions before activating rules. Each position shows current stock, whether an active rule already covers it, what the first check would propose and who approves. Nothing changes.',
    },
    configureReplenishmentBatch: {
      method: 'POST',
      metadata: requires('procurement.manage'),
      path: `${path}/:definitionId/replenishment/activations/batch`,
      pathParams: params,
      body: replenishmentBatchRequestSchema,
      responses: { 200: replenishmentBatchResultSchema },
      summary: 'Activate several replenishment rules',
      description:
        'Requires `procurement.manage`. Activates up to 25 reviewed rules, each for exactly one stock position. Each rule succeeds or fails on its own; an existing rule is never replaced. Resend the same items to retry: activated rules are returned unchanged and never duplicated.',
    },
    coverage: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: '/v1/organizations/:organizationId/workflow-coverage',
      pathParams: organizationParamsSchema,
      query: z.object({
        subjectKind: z.literal('inventory_position'),
        subjectId: z.string().uuid(),
      }),
      responses: { 200: workflowCoverageSchema },
      summary: 'Read workflow coverage for a record',
      description:
        'Returns the workflows that can cover a stock position, with the same readiness, blockers and next action as the workflow itself, scoped to that record.',
    },
    startReplenishment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
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
      metadata: requires('procurement.read'),
      path: `${path}/:definitionId/replenishment/runs/:runId`,
      pathParams: params.extend({ runId: z.string().uuid() }),
      responses: { 200: replenishmentReviewSchema },
      summary: 'Review a replenishment run',
      description:
        'Returns recorded stock, supplier, policy decision, current purchase-order status and independent verification. Only someone other than the requester with `procurement.manage` and `decisions.respond` can respond to a pending proposal.',
    },
    decideReplenishment: {
      method: 'POST',
      metadata: requires('procurement.manage'),
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
        'Requires `procurement.manage` and `decisions.respond`. Someone other than the requester decides on the exact proposal. Current stock, activation and policy are checked again before creating the order.',
    },
    list: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(workflowSummarySchema) }) },
      summary: 'List workspace workflows',
      description:
        'Requires `workflows.read`. People can inspect published versions and activation status. Viewing a workflow never activates it.',
    },
    detail: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${path}/:definitionId`,
      pathParams: params,
      responses: { 200: workflowDetailSchema },
      summary: 'Inspect a workflow',
      description:
        'Read published steps, versions, prerequisites and historical grants. Process versions show the exact order of decisions, actions, waits and verification.',
    },
    runs: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${path}/:definitionId/runs`,
      pathParams: params,
      responses: { 200: z.object({ items: z.array(workflowRunViewSchema) }) },
      summary: 'Read recent workflow runs',
      description:
        'Returns the 50 most recent runs with subject, actor, trigger and step evidence. Process runs show their current state and recorded outputs. Execution and verification results are separate.',
    },
    fire: {
      method: 'POST',
      metadata: requires('workflows.triggers.manage'),
      path: `${path}/:definitionId/starts`,
      pathParams: params,
      body: fireWorkflowSchema,
      responses: { 200: workflowRunViewSchema },
      summary: 'Start or schedule a workflow run',
      description:
        'Requires `workflows.triggers.manage`. Submits typed signal evidence for an exact version and resource. Reuse the source ID and complete body on retry. Starts do not grant execution authority. Schedules start once at the time specified by the version.',
    },
    cancelStart: {
      method: 'POST',
      metadata: requires('workflows.triggers.manage'),
      path: `${path}/:definitionId/starts/:runId/cancel`,
      pathParams: params.extend({ runId: z.string().uuid() }),
      body: z.object({}).strict(),
      responses: { 200: workflowRunViewSchema },
      summary: 'Cancel a pending scheduled start',
    },
    activate: {
      method: 'POST',
      metadata: requires('playbooks.activate'),
      path: `${path}/:definitionId/activations`,
      pathParams: params,
      body: activateWorkflowSchema,
      responses: { 200: workflowActivationSchema },
      summary: 'Activate a reviewed version',
      description:
        'Requires `playbooks.activate`. Activates supported Resolution versions for your own principal and explicit orders on one connection. Other definitions remain available for review. Review the exact digest, scope and approval behavior. Reuse the same ID and body after an uncertain response. Conflicting, overlapping or stale grants return 409; revoked records cannot be restored.',
    },
    activateCase: {
      method: 'POST',
      metadata: requires('workflows.publish'),
      path: `${path}/:definitionId/case-activations`,
      pathParams: params,
      body: activateCaseWorkflowSchema,
      responses: { 200: workflowActivationSchema },
      summary: 'Turn on a case workflow',
      description:
        'Requires `workflows.publish`. Lets a built-in workflow start a run for each new case of its issue type. Runs act as the caller; every change still needs policy approval by someone else who can approve changes. Review the exact version digest and policy version. Reuse the same ID and body after an uncertain response. A second active activation returns 409.',
    },
    revoke: {
      method: 'POST',
      // Replenishment, case-workflow and playbook revokes each check their own permission.
      metadata: requires([
        'playbooks.activate',
        'procurement.manage',
        'workflows.publish',
      ]),
      path: `${path}/:definitionId/activations/:activationId/revoke`,
      pathParams: params.extend({ activationId: z.string().uuid() }),
      body: z
        .object({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      responses: { 200: workflowActivationSchema },
      summary: 'Revoke a workflow activation',
      description:
        'Requires `playbooks.activate` or `procurement.manage`. Prevents future admission under this artifact. Repeated revocation is safe. Revocation preserves historical grants and does not undo already-dispatched work.',
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
