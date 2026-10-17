import { randomUUID } from 'node:crypto';

import type { EffectRegistry } from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import type { BoundActionStep } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';
import type { ProposedAction, ScopedResponsibilityFacts } from '@luma/policies';
import { createLatestPolicyDecisionReader } from '@luma/policies/composition';
import {
  createGovernedFollowUps,
  type FollowUpPlan,
  followUpReceiptMatches,
  followUpScopeFingerprint,
  type GovernedFollowUps,
  supplierFollowUpNote,
} from '@luma/procurement';
import type { SupplierCommitments } from '@luma/procurement/composition';
import { createFollowUpPlanStore } from '@luma/procurement/composition';

import type { createSafetyServices } from './services.js';

const actionFor = (plan: FollowUpPlan): ProposedAction => ({
  schemaVersion: 1,
  id: plan.id,
  tenantId: plan.tenantId,
  capability: 'procurement.follow-up.record',
  capabilityVersion: '0',
  connectionId: plan.tenantId,
  target: { kind: 'purchase_order', id: plan.orderId },
  parameters: {
    planId: plan.id,
    followUpId: plan.followUpId,
    workflowRunId: plan.workflowRunId,
    key: plan.key,
    nextCheckAt: plan.nextCheckAt,
    orderRevision: plan.orderRevision,
    scopeFingerprint: plan.orderScopeFingerprint,
    governed: true,
  },
  preconditions: { evidenceRefs: [plan.orderId], validUntil: plan.expiresAt },
  expectedPostcondition: { recorded: true },
  risk: 'low',
  proposedBy: { kind: 'user', id: plan.requestedBy },
  expiresAt: plan.expiresAt,
});

/** Bridges the procurement owner's immutable internal-note proposals to the shared admission engine. */
export function createScopedSupplierFollowUp(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext'>;
  commitments: Pick<SupplierCommitments, 'order' | 'respond'>;
  safety: ReturnType<typeof createSafetyServices>;
  runCurrent(context: TenantContext, workflowRunId: string): Promise<boolean>;
  notifyDecision(
    context: TenantContext,
    workflowRunId: string,
  ): Promise<boolean>;
  environment(
    context: TenantContext,
    orderId: string,
  ): Promise<import('@luma/connections').SourceEnvironmentProof>;
  waitMs?: number;
}): {
  service: GovernedFollowUps;
  effects: EffectRegistry;
  eligible(context: TenantContext, step: BoundActionStep): Promise<boolean>;
  facts(
    context: TenantContext,
    action: ProposedAction,
  ): Promise<ScopedResponsibilityFacts | null>;
} {
  const store = createFollowUpPlanStore(options.database);
  const now = () => new Date();

  async function current(context: TenantContext, orderId: string) {
    const view = await options.commitments.order(context, orderId);
    const attention = view.progress.attention.find((item) =>
      ['confirmation_overdue', 'delivery_overdue'].includes(item.kind),
    );
    if (!attention || ['closed', 'cancelled'].includes(view.order.status))
      return null;

    return {
      orderRevision: view.order.revision,
      orderScopeFingerprint: followUpScopeFingerprint(view.order),
      key: attention.key,
      observedAt: now().toISOString(),
      nextCheckAt: new Date(
        now().getTime() + (options.waitMs ?? 4 * 3600000),
      ).toISOString(),
    };
  }

  async function planFor(
    context: TenantContext,
    intent: Parameters<EffectRegistry['resolve']>[1],
  ) {
    if (
      intent.capability !== 'procurement.follow-up.record' ||
      intent.capabilityVersion !== '0' ||
      intent.connectionId !== context.tenantId ||
      intent.target.kind !== 'purchase_order' ||
      typeof intent.parameters.planId !== 'string' ||
      intent.parameters.governed !== true
    )
      return null;
    const plan = await store.get(context, intent.parameters.planId);
    if (!plan || plan.orderId !== intent.target.id) return null;
    const expected = actionFor(plan);
    if (
      canonicalJson(intent.parameters) !== canonicalJson(expected.parameters) ||
      intent.preconditions.validUntil !== expected.preconditions.validUntil ||
      intent.expectedPostcondition.recorded !== true
    )
      return null;

    return plan;
  }

  async function valid(context: TenantContext, plan: FollowUpPlan) {
    const [head, runCurrent, owned, sourceCurrent] = await Promise.all([
      store.head(context, plan.workflowRunId),
      options.runCurrent(context, plan.workflowRunId),
      current(context, plan.orderId),
      options
        .environment(context, plan.orderId)
        .then((proof) =>
          options.safety.autonomy.evidenceCurrent(context, plan.id, proof),
        ),
    ]);

    return (
      head?.id === plan.id &&
      runCurrent &&
      sourceCurrent &&
      owned?.key === plan.key &&
      owned.orderRevision === plan.orderRevision &&
      owned.orderScopeFingerprint === plan.orderScopeFingerprint &&
      now().getTime() < Date.parse(plan.expiresAt)
    );
  }

  const effects: EffectRegistry = {
    async resolve(context, intent) {
      const plan = await planFor(context, intent);
      if (!plan) return null;

      return {
        capability: 'procurement.follow-up.record',
        version: '0',
        minimumRisk: 'low',
        permission: 'procurement.manage',
        mechanism: 'api',
        dispatchIdentity: 'native-supplier-follow-up/1',
        executor: { kind: 'service', id: 'native-supplier-follow-up/1' },
        checkPreconditions: async () => valid(context, plan),
        async execute() {
          try {
            await options.commitments.respond(context, plan.orderId, {
              id: plan.followUpId,
              key: plan.key,
              response: 'following_up',
              note: supplierFollowUpNote(plan.nextCheckAt),
              nextCheckAt: plan.nextCheckAt,
              expectedOrderRevision: plan.orderRevision,
              expectedScopeFingerprint: plan.orderScopeFingerprint,
            });
          } catch (error) {
            if (
              error instanceof IdentityError &&
              [409, 422].includes(error.statusCode)
            )
              throw new ConnectorError({
                code: 'conflict',
                effect: 'none',
                retry: 'never',
                dispatch: 'not_dispatched',
              });
            throw error;
          }

          return { evidenceRefs: [plan.followUpId] };
        },
        async verify() {
          const view = await options.commitments.order(context, plan.orderId);
          const receipt = view.followUps.find(
            (item) => item.id === plan.followUpId,
          );

          return {
            outcome: followUpReceiptMatches(plan, receipt)
              ? 'passed'
              : 'failed',
            observationRefs: [plan.orderId],
            observedAt: now().toISOString(),
            evaluatorVersion: 'procurement-follow-up-recorded/1',
          };
        },
      };
    },
  };
  const latestDecision = createLatestPolicyDecisionReader(options.database);
  const service = createGovernedFollowUps({
    store,
    managed: options.safety.autonomy.managed,
    refreshContext: options.identity.refreshContext,
    current,
    now,
    id: randomUUID,
    admission: {
      async refreshability(context, plan) {
        if (!(await options.runCurrent(context, plan.workflowRunId)))
          return { refreshable: false, refreshBlock: 'workflow_inactive' };
        if (!(await options.safety.autonomy.released(context.tenantId)))
          return { refreshable: false, refreshBlock: 'release_unavailable' };

        return { refreshable: true, refreshBlock: null };
      },
      async verify(context, plan) {
        const execution = await options.safety.execution.get(context, plan.id);
        if (
          !execution ||
          !('record' in execution) ||
          execution.record.attempt.businessOutcome !== 'satisfied'
        )
          return false;
        const view = await options.commitments.order(context, plan.orderId);

        return followUpReceiptMatches(
          plan,
          view.followUps.find((item) => item.id === plan.followUpId),
        );
      },
      async reconcile(context, plan) {
        await options.safety.execution.reconcile(context, plan.id);
      },
      async prepare(context, plan, reviewOnly) {
        const action = actionFor(plan);
        const artifact = await options.safety.provisioning.activate(context, {
          id: 'supplier-follow-up-governed',
          version: '1',
          generation: {
            kind: 'manual',
            reference: 'supplier-follow-up-governed/1',
          },
          steps: {
            'record-follow-up': {
              capability: action.capability,
              capabilityVersion: '0',
              targetKind: 'purchase_order',
              minimumRisk: 'low',
            },
          },
        });
        await options.safety.provisioning.bind(context, {
          runId: plan.executionRunId,
          stepId: 'record-follow-up',
          tenantId: context.tenantId,
          principalId: plan.requestedBy,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          artifactDigest: artifact.digest,
          subject: { kind: 'supplier_follow_up', id: plan.id },
          eligibilityValidUntil: plan.expiresAt,
          action,
        });
        const adapter = await effects.resolve(context, action);
        if (reviewOnly)
          await options.safety.policies.evaluate(
            context,
            action,
            parseAction(action).hash,
            {
              available:
                !!adapter && (await adapter.checkPreconditions(action)),
              minimumRisk: 'low',
              permission: 'procurement.manage',
            },
          );
      },
      async execute(context, plan) {
        const prior = await options.safety.execution.get(context, plan.id);
        const result =
          prior ??
          (await options.safety.execution.execute(context, {
            runId: plan.executionRunId,
            stepId: 'record-follow-up',
          }));
        if (result.state === 'approval_required')
          return {
            state: 'awaiting_approval',
            proposalId: plan.id,
            decisionId: result.decision.id,
          };
        if (result.state === 'not_executed')
          return {
            state: 'not_executed',
            proposalId: plan.id,
            reason: result.reason,
          };
        if (result.state === 'denied')
          return {
            state: 'denied',
            proposalId: plan.id,
            reason: result.decision.autonomyBlock ?? result.decision.reason,
          };
        if (result.state === 'reconciliation_required')
          return {
            state: 'reconciliation_required',
            proposalId: plan.id,
            reason: 'A reserved or uncertain note must reconcile before retry.',
          };
        if (!('record' in result))
          throw new Error('Execution result has no receipt');

        return result.record.attempt.businessOutcome === 'satisfied'
          ? {
              state: 'accepted',
              proposalId: plan.id,
              receiptId: plan.followUpId,
            }
          : {
              state: 'denied',
              proposalId: plan.id,
              reason: 'The note has not been independently verified.',
            };
      },
      async respond(context, plan, decisionId, outcome) {
        const readiness = await this.refreshability(context, plan);
        if (!readiness.refreshable)
          throw new IdentityError(
            409,
            'CONFLICT',
            'The original workflow or scoped release is unavailable. Existing attempts can still be verified.',
          );
        if ((await latestDecision(context, plan.id)) !== decisionId)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Decision changed. Refresh the review.',
          );
        if (!(await valid(context, plan)))
          throw new IdentityError(
            409,
            'CONFLICT',
            'Proposal is stale or superseded. Refresh it; approval is not carried forward.',
          );
        await options.safety.policies.respond(
          context,
          decisionId,
          outcome,
          plan.expiresAt,
        );
        // Consent is already committed. A lost wake uses the process's durable polling fallback;
        // notification only rereads the bound action and cannot replay an uncertain attempt.
        await options
          .notifyDecision(context, plan.workflowRunId)
          .catch(() => false);
      },
      async review(context, plan) {
        const id = await latestDecision(context, plan.id);
        const decision = id
          ? await options.safety.policies.decision(context, id)
          : null;
        const renewal = await this.refreshability(context, plan);
        const stale =
          !renewal.refreshable ||
          !(await valid(context, plan)) ||
          (!!decision &&
            decision.policyVersion !==
              (await options.safety.policies.currentVersion(context.tenantId)));

        return {
          ...renewal,
          decisionId: id,
          outcome: decision?.outcome ?? null,
          stale,
          reason: !renewal.refreshable
            ? renewal.refreshBlock
            : stale
              ? 'Refresh the proposal. A previous approval cannot authorize refreshed evidence.'
              : (decision?.autonomyBlock ?? decision?.reason ?? null),
        };
      },
    },
  });

  return {
    service,
    effects,
    /** Reloads the exact immutable plan and its owned order for each admission check. */
    async eligible(context: TenantContext, step: BoundActionStep) {
      const plan = await planFor(context, step.action);

      return (
        !!plan &&
        step.subject?.kind === 'supplier_follow_up' &&
        step.subject.id === plan.id &&
        (await valid(context, plan))
      );
    },
    /** Reports fresh owner-read internal-note quantities; unknown prices/provenance remain unknown. */
    async facts(
      context: TenantContext,
      action: ProposedAction,
    ): Promise<ScopedResponsibilityFacts | null> {
      const plan = await planFor(context, action);
      if (!plan || !(await valid(context, plan))) return null;
      const view = await options.commitments.order(context, plan.orderId);
      const locations = [
        ...new Set(
          view.order.lines
            .map((line) => line.locationId)
            .filter((id): id is string => !!id),
        ),
      ];

      const proof = await options.environment(context, plan.orderId);

      return {
        recordId: plan.orderId,
        connectionId: context.tenantId,
        supplierId: view.order.supplierId,
        locationId: locations.length === 1 ? locations[0]! : null,
        quantity: '1',
        unit: 'follow_up',
        exposure: null,
        observedAt: now().toISOString(),
        complete: true,
        environment: proof.environment,
        environmentProvenance: proof.provenance,
      };
    },
  };
}
