import { z } from 'zod';

import { activityActorSchema } from '../activity.js';
import { codeEvaluationSchema, evaluateCodeSchema } from '../code-steps.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';
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

const params = organizationParamsSchema.extend({
  definitionId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
});
const path = '/v1/organizations/{organizationId}/workflows';

export const workflowsContract = {
  evaluateCode: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/code-evaluations`,
      summary: 'Evaluate a published Code Step',
      description:
        'Requires `workflows.author`. Tests an exact version with example inputs, capability replies and expected outputs. Evaluation does not call connected systems. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: evaluateCodeSchema }))
    .output(codeEvaluationSchema),
  codeEvaluation: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}/code-evaluations/{evaluationId}`,
      summary: 'Read a Code Step evaluation',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: params.extend({ evaluationId: z.string().uuid() }) }),
    )
    .output(codeEvaluationSchema),
  cancelCodeEvaluation: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/code-evaluations/{evaluationId}/cancel`,
      summary: 'Cancel a running Code Step evaluation',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({ evaluationId: z.string().uuid() }),
        body: z.object({}).strict(),
      }),
    )
    .output(codeEvaluationSchema),
  cancelCodeStep: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/runs/{runId}/code/{stepId}/cancel`,
      summary: 'Stop a Code Step',
      description:
        'Stops computation and prevents new capability requests. Actions already admitted may still complete and require reconciliation.',
    })
    .meta({
      access: requires('workflows.triggers.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({
          runId: z.string().uuid(),
          stepId: z.string().max(80),
        }),
        body: z.object({}).strict(),
      }),
    )
    .output(z.object({ cancelled: z.literal(true) })),
  replenishmentSetup: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}/replenishment`,
      summary: 'Read replenishment rules and a page of stock choices',
      description:
        'Returns up to 50 stock choices. Search by SKU or filter to a position or connection. Continue with nextCursor and the same filters. Rule readiness includes the current stock for every configured rule, independently of this page.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: params, query: replenishmentPositionQuerySchema }),
    )
    .output(replenishmentSetupSchema),
  configureReplenishment: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/replenishment/activations`,
      summary: 'Activate a replenishment rule',
      description:
        'Requires `procurement.manage`. Reviews a stock position, supplier and quantity limits. Target stock must exceed the minimum. Reuse the exact ID and body when retrying.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: replenishmentRuleSchema }))
    .output(workflowActivationSchema),
  previewReplenishment: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/replenishment/previews`,
      summary: 'Preview replenishment rules',
      description:
        'Requires `procurement.manage`. Checks up to 25 stock positions before activating rules. Each position shows current stock, whether an active rule already covers it, what the first check would propose and who approves. Nothing changes.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: params, body: replenishmentPreviewRequestSchema }),
    )
    .output(replenishmentPreviewSchema),
  configureReplenishmentBatch: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/replenishment/activations/batch`,
      summary: 'Activate several replenishment rules',
      description:
        'Requires `procurement.manage`. Activates up to 25 reviewed rules, each for exactly one stock position. Each rule succeeds or fails on its own; an existing rule is never replaced. Resend the same items to retry: activated rules are returned unchanged and never duplicated.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: replenishmentBatchRequestSchema }))
    .output(replenishmentBatchResultSchema),
  coverage: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/workflow-coverage',
      summary: 'Read workflow coverage for a record',
      description:
        'Returns the workflows that can cover a stock position, with the same readiness, blockers and next action as the workflow itself, scoped to that record.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          subjectKind: z.literal('inventory_position'),
          subjectId: z.string().uuid(),
        }),
      }),
    )
    .output(workflowCoverageSchema),
  startReplenishment: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/replenishment/starts`,
      summary: 'Check low stock and start replenishment',
      description:
        'Reads current stock on the server and starts the activated version when stock is below its minimum. Reuse the request ID after an uncertain response.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params,
        body: z
          .object({ id: z.string().uuid(), activationId: z.string().uuid() })
          .strict(),
      }),
    )
    .output(workflowRunViewSchema),
  replenishmentReview: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}/replenishment/runs/{runId}`,
      summary: 'Review a replenishment run',
      description:
        'Returns recorded stock, supplier, policy decision, current purchase-order status and independent verification. Only someone other than the requester with `procurement.manage` and `decisions.respond` can respond to a pending proposal.',
    })
    .meta({
      access: requires('procurement.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params.extend({ runId: z.string().uuid() }) }))
    .output(replenishmentReviewSchema),
  decideReplenishment: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/replenishment/runs/{runId}/decision`,
      summary: 'Approve or reject a replenishment proposal',
      description:
        'Requires `procurement.manage` and `decisions.respond`. Someone other than the requester decides on the exact proposal. Current stock, activation and policy are checked again before creating the order.',
    })
    .meta({
      access: requires('procurement.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({ runId: z.string().uuid() }),
        body: z
          .object({
            decisionId: z.string().uuid(),
            outcome: z.enum(['approved', 'rejected']),
          })
          .strict(),
      }),
    )
    .output(replenishmentReviewSchema),
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'List workspace workflows',
      description:
        'Requires `workflows.read`. People can inspect published versions and activation status. Viewing a workflow never activates it.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(workflowSummarySchema) })),
  detail: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}`,
      summary: 'Inspect a workflow',
      description:
        'Read published steps, versions, prerequisites and historical grants. Process versions show the exact order of decisions, actions, waits and verification.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params }))
    .output(workflowDetailSchema),
  runs: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}/runs`,
      summary: 'Read recent workflow runs',
      description:
        'Returns the 50 most recent runs with subject, actor, trigger and step evidence, and the names of the people who started them. Process runs show their current state and recorded outputs. Execution and verification results are separate.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params }))
    .output(
      z.object({
        items: z.array(workflowRunViewSchema),
        /** The people who started the runs, or who an agent started them for. */
        people: z.array(activityActorSchema).max(100),
      }),
    ),
  fire: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/starts`,
      summary: 'Start or schedule a workflow run',
      description:
        'Requires `workflows.triggers.manage`. Submits typed signal evidence for an exact version and resource. Reuse the source ID and complete body on retry. Starts do not grant execution authority. Schedules start once at the time specified by the version.',
    })
    .meta({
      access: requires('workflows.triggers.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: fireWorkflowSchema }))
    .output(workflowRunViewSchema),
  cancelStart: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/starts/{runId}/cancel`,
      summary: 'Cancel a pending scheduled start',
    })
    .meta({
      access: requires('workflows.triggers.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({ runId: z.string().uuid() }),
        body: z.object({}).strict(),
      }),
    )
    .output(workflowRunViewSchema),
  activate: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/activations`,
      summary: 'Activate a reviewed version',
      description:
        'Requires `playbooks.activate`. Activates supported Resolution versions for your own principal and explicit orders on one connection. Other definitions remain available for review. Review the exact digest, scope and approval behavior. Reuse the same ID and body after an uncertain response. Conflicting, overlapping or stale grants return 409; revoked records cannot be restored.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: activateWorkflowSchema }))
    .output(workflowActivationSchema),
  activateCase: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/case-activations`,
      summary: 'Turn on a case workflow',
      description:
        'Requires `workflows.publish`. Lets a built-in workflow start a run for each new case of its issue type. Runs act as the caller; every change still needs policy approval by someone else who can approve changes. Review the exact version digest and policy version. Reuse the same ID and body after an uncertain response. A second active activation returns 409.',
    })
    .meta({
      access: requires('workflows.publish'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: activateCaseWorkflowSchema }))
    .output(workflowActivationSchema),
  revoke: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/activations/{activationId}/revoke`,
      summary: 'Revoke a workflow activation',
      description:
        'Requires `playbooks.activate` or `procurement.manage`. Prevents future admission under this artifact. Repeated revocation is safe. Revocation preserves historical grants and does not undo already-dispatched work.',
    })
    .meta({
      access: requires([
        'playbooks.activate',
        'procurement.manage',
        'workflows.publish',
      ]),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({ activationId: z.string().uuid() }),
        body: z
          .object({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      }),
    )
    .output(workflowActivationSchema),
};
