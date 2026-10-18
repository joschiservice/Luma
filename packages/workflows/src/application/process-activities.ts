import type { ActionAdmission } from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';

import type { CodeRunner } from '../domain/code-step.js';
import type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
import type { WorkflowTriggerRun } from '../domain/workflow.js';
import { type CodeJournal, createCodeActivity } from './code-activity.js';
import type { ProcessActivities } from './process-runtime.js';

/** Connects capability-specific binding and verification to shared Action Admission. */
export function createProcessActivities(deps: {
  code?: { runner: CodeRunner; journal: CodeJournal };
  resolveContext(run: ProcessRun): Promise<TenantContext>;
  loadRun(
    context: TenantContext,
    id: string,
  ): Promise<WorkflowTriggerRun | null>;
  loadVersion(
    context: TenantContext,
    id: string,
    version: string,
  ): Promise<ProcessWorkflowVersion | null>;
  admission: Pick<
    ActionAdmission,
    'get' | 'execute' | 'reconcile' | 'approvalPending'
  >;
  /** Persists an immutable action binding for this exact run and step before admission. */
  bindAction(
    context: TenantContext,
    run: ProcessRun,
    version: ProcessWorkflowVersion,
    step: Extract<ProcessStep, { kind: 'capability' }>,
    outputs: ProcessStepOutput[],
  ): Promise<{ proposalId: string }>;
  read: ProcessActivities['read'];
  decision: ProcessActivities['decision'];
  verify: ProcessActivities['verify'];
  record(
    context: TenantContext,
    runId: string,
    output: ProcessStepOutput,
  ): Promise<void>;
}): ProcessActivities {
  async function authorize(run: ProcessRun) {
    const context = await deps.resolveContext(run);
    requireTenant(context, run.tenantId);
    // The stored principal must still be allowed to prepare actions; admission checks execution.
    requirePermission(context, 'actions.propose');
    if (run.actor.kind !== 'user' || context.actor.id !== run.actor.id)
      throw new Error('Workflow principal changed');
    const stored = await deps.loadRun(context, run.id);
    if (
      !stored ||
      stored.state !== 'awaiting_admission' ||
      stored.versionDigest !== run.versionDigest ||
      stored.contextDigest !== run.contextDigest ||
      stored.definitionId !== run.definitionId ||
      stored.actor.id !== run.actor.id ||
      stored.version !== run.version ||
      canonicalJson(stored.subject) !== canonicalJson(run.subject) ||
      canonicalJson(stored.context) !== canonicalJson(run.context)
    )
      throw new Error('Workflow run binding changed');

    return context;
  }

  const activities: ProcessActivities = {
    read: async (run, step) => {
      await authorize(run);

      return deps.read(run, step);
    },
    decision: async (run, step) => {
      await authorize(run);

      return deps.decision(run, step);
    },
    verify: async (run, step, outputs) => {
      await authorize(run);

      return deps.verify(run, step, outputs);
    },
    record: async (run, output) =>
      deps.record(await authorize(run), run.id, output),
    actionApprovalPending: async (run, _step, proposalId, decisionId) =>
      deps.admission.approvalPending(
        await authorize(run),
        proposalId,
        decisionId,
      ),
    async action(run, version, step, outputs) {
      const context = await authorize(run);
      const published = await deps.loadVersion(
        context,
        run.definitionId,
        run.version,
      );
      if (
        !published ||
        published.digest !== run.versionDigest ||
        version.digest !== run.versionDigest ||
        version.definition.id !== run.definitionId ||
        canonicalJson(version) !== canonicalJson(published) ||
        !published.steps.some(
          (item) =>
            canonicalJson(item) === canonicalJson(step) &&
            item.kind === 'capability',
        )
      )
        throw new Error('Action does not belong to this run version');
      let proposalId: string;
      try {
        ({ proposalId } = await deps.bindAction(
          context,
          run,
          version,
          step,
          outputs,
        ));
      } catch (error) {
        if (error instanceof IdentityError && error.statusCode === 409)
          return { state: 'denied', proposalId: run.id, reason: error.message };
        throw error;
      }
      let result = await deps.admission.get(context, proposalId);
      if (
        !result ||
        (!('record' in result) && result.state !== 'not_executed')
      ) {
        try {
          result = await deps.admission.execute(context, {
            runId: run.id,
            stepId: step.id,
          });
        } catch (error) {
          result = await deps.admission.get(context, proposalId);
          if (!result || !('record' in result)) {
            if (error instanceof AdmissionRejected)
              return { state: 'denied', proposalId, reason: error.message };
            throw error;
          }
        }
      }
      if (result.state === 'not_executed')
        return { state: 'not_executed', proposalId, reason: 'observe_only' };
      if (result.state === 'approval_required')
        return {
          state: 'awaiting_approval',
          proposalId,
          decisionId: result.decision.id,
        };
      if (result.state === 'denied')
        return { state: 'denied', proposalId, reason: result.decision.reason };
      if (
        !('record' in result) ||
        result.record.admission?.runId !== run.id ||
        result.record.admission.stepId !== step.id ||
        result.record.proposalId !== proposalId
      )
        throw new Error('Action receipt does not match this workflow step');
      if (result.state === 'reconciliation_required') {
        result = await deps.admission.reconcile(context, proposalId);
        if (!('record' in result) || result.state === 'reconciliation_required')
          return {
            state: 'reconciliation_required',
            proposalId,
            reason: 'reconciliation_required',
          };
      }
      if (result.state !== 'succeeded')
        return { state: 'denied', proposalId, reason: 'action_failed' };

      return {
        state: 'accepted',
        proposalId,
        receiptId: result.record.attempt.id,
      };
    },
  };
  if (deps.code)
    activities.code = createCodeActivity({
      ...deps.code,
      activities,
      async authorize(run, version, step) {
        const context = await authorize(run);
        const published = await deps.loadVersion(
          context,
          run.definitionId,
          run.version,
        );
        if (
          !published ||
          canonicalJson(published) !== canonicalJson(version) ||
          published.digest !== run.versionDigest ||
          !published.steps.some(
            (item) =>
              item.kind === 'code' &&
              canonicalJson(item) === canonicalJson(step),
          )
        )
          throw new Error('Code does not belong to this run version');
      },
    });

  return activities;
}
