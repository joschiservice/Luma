import type {
  ActionAdmission,
  ActivatedArtifact,
  BoundActionStep,
  ExecutionResult,
} from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
import type { ProposedAction } from '@luma/policies';

import type {
  PlaybookActivation,
  PlaybookSnapshot,
  PlaybookVersion,
} from '../domain/playbook.js';
import { playbookEligible, playbookValue } from '../domain/playbook.js';
import { createPlaybookActivations } from './playbook-activations.js';

export interface PlaybookRun {
  id: string;
  tenantId: string;
  principalId: string;
  activationId: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  artifactDigest: string;
  incidentId: string;
  diagnosisRevision: number;
  snapshot: PlaybookSnapshot;
  snapshotDigest: string;
  action: ProposedAction;
  actionHash: string;
  createdAt: string;
}

export interface PlaybookOutcome {
  state: 'awaiting_approval' | 'verified' | 'denied' | 'escalated';
  reason:
    | 'approval_required'
    | 'verified'
    | 'policy_denied'
    | 'ineligible'
    | 'stale_evidence'
    | 'verification_failed'
    | 'verification_inconclusive'
    | 'verification_window_exceeded'
    | 'activation_unavailable'
    | 'admission_rejected'
    | 'reconciliation_required';
  stepId: string;
  proposalId: string;
  decisionId?: string;
  execution?: Extract<ExecutionResult, { record: unknown }>;
}

export interface PlaybookStore {
  publish(context: TenantContext, version: PlaybookVersion): Promise<void>;
  version(
    context: TenantContext,
    definitionId: string,
    version: string,
  ): Promise<PlaybookVersion | null>;
  activate(
    context: TenantContext,
    activation: PlaybookActivation,
  ): Promise<void>;
  activation(
    context: TenantContext,
    id: string,
  ): Promise<PlaybookActivation | null>;
  bind(context: TenantContext, run: PlaybookRun): Promise<PlaybookRun>;
  run(context: TenantContext, id: string): Promise<PlaybookRun | null>;
  record(
    context: TenantContext,
    runId: string,
    outcome: PlaybookOutcome,
  ): Promise<void>;
  outcomes(context: TenantContext, runId: string): Promise<PlaybookOutcome[]>;
}

export interface PlaybookDependencies {
  store: PlaybookStore;
  admission: ActionAdmission;
  provisioning: {
    activate(
      context: TenantContext,
      artifact: unknown,
    ): Promise<ActivatedArtifact>;
    revoke(context: TenantContext, id: string, version: string): Promise<void>;
    artifact(
      context: TenantContext,
      id: string,
      version: string,
    ): Promise<ActivatedArtifact | null>;
    bind(
      context: TenantContext,
      step: Omit<BoundActionStep, 'actionHash'>,
    ): Promise<void>;
  };
  refreshContext(context: TenantContext): Promise<TenantContext>;
  compile(input: unknown): PlaybookVersion;
  parseActivation(
    input: unknown,
  ): Omit<PlaybookActivation, 'tenantId' | 'versionDigest' | 'artifactDigest'>;
  parseSnapshot(input: unknown, version: PlaybookVersion): PlaybookSnapshot;
  parseAction(input: unknown): { action: ProposedAction; hash: string };
  hash(input: unknown): string;
  now(): Date;
}

const artifactId = (id: string) => `playbook:${id}`;

const rank = { low: 0, medium: 1, high: 2 };

/**
 * Creates playbook publication, activation, binding, and execution commands constrained by
 * action admission.
 */
export function createPlaybookService(deps: PlaybookDependencies) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(fresh, ['owner', 'admin']);
    if (fresh.actor.id !== context.actor.id)
      throw new Error('Playbook principal changed');

    return fresh;
  }

  async function load(context: TenantContext, id: string) {
    const run = await deps.store.run(context, id);
    if (!run || run.principalId !== context.actor.id)
      throw new Error('Playbook run not found');
    const version = await deps.store.version(
      context,
      run.definitionId,
      run.version,
    );
    if (
      !version ||
      version.digest !== run.versionDigest ||
      deps.hash(run.snapshot) !== run.snapshotDigest
    )
      throw new Error('Playbook run integrity mismatch');

    return { run, version };
  }

  async function perform(
    context: TenantContext,
    id: string,
    recovery: boolean,
  ): Promise<PlaybookOutcome> {
    context = await authorize(context);
    const { run, version } = await load(context, id);
    const ir = version.ir;

    async function record(outcome: Omit<PlaybookOutcome, 'proposalId'>) {
      const result = { ...outcome, proposalId: run.action.id };
      await deps.store.record(context, id, result);

      return result;
    }

    // Recover reservations before checking evidence age; recovery never dispatches.
    let result = await deps.admission.get(context, run.action.id);
    if (!result || !('record' in result)) {
      if (recovery)
        return record({
          state: 'escalated',
          reason: 'reconciliation_required',
          stepId: ir.recovery.id,
        });
      const prior = await deps.store.outcomes(context, id);
      const terminal = prior.find(
        (o) =>
          o.state === 'denied' ||
          o.state === 'escalated' ||
          o.state === 'verified',
      );
      if (terminal) return terminal;
      const active = await deps.provisioning.artifact(
        context,
        artifactId(run.activationId),
        run.version,
      );
      if (
        !active?.active ||
        active.digest !== run.artifactDigest ||
        active.playbook?.versionDigest !== run.versionDigest
      )
        return record({
          state: 'denied',
          reason: 'activation_unavailable',
          stepId: ir.action.id,
        });
      const eligibility = playbookEligible(
        ir,
        run.snapshot,
        deps.now().getTime(),
      );
      if (eligibility !== 'eligible')
        return record({
          state: 'escalated',
          reason: eligibility,
          stepId: ir.eligibility.id,
        });
      try {
        result = await deps.admission.execute(context, {
          runId: id,
          stepId: ir.action.id,
        });
      } catch (error) {
        // An interrupted dispatch may already have reserved the action. Recovery reads only.
        result = await deps.admission.get(context, run.action.id);
        if (!result || !('record' in result)) {
          if (!(error instanceof AdmissionRejected)) throw error;

          return record({
            state: 'escalated',
            reason: 'admission_rejected',
            stepId: ir.action.id,
          });
        }
      }
    }
    if (result.state === 'approval_required')
      return record({
        state: 'awaiting_approval',
        reason: 'approval_required',
        decisionId: result.decision.id,
        stepId: ir.approval.id,
      });
    if (result.state === 'denied')
      return record({
        state: 'denied',
        reason: 'policy_denied',
        decisionId: result.decision.id,
        stepId: ir.action.id,
      });
    if (!('record' in result)) throw new Error('Missing execution receipt');
    if (
      result.record.admission?.runId !== id ||
      result.record.admission.artifactDigest !== run.artifactDigest ||
      result.record.actionHash !== run.actionHash
    )
      throw new Error('Playbook execution binding mismatch');
    if (recovery && result.state === 'reconciliation_required')
      result = await deps.admission.reconcile(context, run.action.id);
    if (!('record' in result)) throw new Error('Unexpected recovery decision');
    if (result.state === 'reconciliation_required')
      return record({
        state: 'escalated',
        reason: 'reconciliation_required',
        stepId: ir.recovery.id,
        execution: result,
      });
    const attempt = result.record.attempt;
    const verification = attempt.verification;
    const elapsed = verification
      ? Date.parse(verification.observedAt) - Date.parse(attempt.startedAt)
      : NaN;
    const inWindow =
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed <= ir.verification.maxDurationSeconds * 1000 &&
      Date.parse(verification!.observedAt) <= deps.now().getTime();
    const valid =
      verification?.evaluatorVersion === ir.verification.evaluatorVersion &&
      verification.observationRefs.length > 0;
    const verified =
      result.state === 'succeeded' &&
      verification?.outcome === 'passed' &&
      valid &&
      inWindow;

    return record({
      state: verified ? 'verified' : 'escalated',
      reason: verified
        ? 'verified'
        : !inWindow && verification
          ? 'verification_window_exceeded'
          : !valid
            ? 'verification_inconclusive'
            : 'verification_failed',
      stepId: ir.verification.id,
      execution: result,
    });
  }

  return {
    async publish(context: TenantContext, source: unknown) {
      context = await authorize(context);
      const version = deps.compile(source);
      await deps.store.publish(context, version);

      return version;
    },
    ...createPlaybookActivations(deps),
    async bind(
      context: TenantContext,
      input: {
        activationId: string;
        incidentId: string;
        diagnosisRevision: number;
        action: ProposedAction;
        snapshot: PlaybookSnapshot;
      },
    ) {
      context = await authorize(context);
      const activation = await deps.store.activation(
        context,
        input.activationId,
      );
      if (
        !activation ||
        !activation.grants.principalIds.includes(context.actor.id)
      )
        throw new Error('Playbook activation not found');
      const version = await deps.store.version(
        context,
        activation.definitionId,
        activation.version,
      );
      if (!version || version.digest !== activation.versionDigest)
        throw new Error('Playbook version mismatch');
      const snapshot = deps.parseSnapshot(input.snapshot, version);
      const { action, hash } = deps.parseAction(input.action);
      requireTenant(context, action.tenantId);
      const node = version.ir.action;
      const resolve = (values: typeof node.parameters) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            playbookValue(value, snapshot),
          ]),
        );
      if (
        action.proposedBy.kind !== 'user' ||
        action.proposedBy.id !== context.actor.id ||
        action.capability !== node.capability ||
        action.capabilityVersion !== node.capabilityVersion ||
        action.target.kind !== node.targetKind ||
        rank[action.risk] < rank[node.minimumRisk] ||
        !activation.grants.connectionIds.includes(action.connectionId) ||
        !activation.grants.targetIds.includes(action.target.id) ||
        deps.hash(action.parameters) !== deps.hash(resolve(node.parameters)) ||
        deps.hash(action.expectedPostcondition) !==
          deps.hash(resolve(node.expectedPostcondition)) ||
        deps.hash([...action.preconditions.evidenceRefs].sort()) !==
          deps.hash(snapshot.evidence.observations.map((o) => o.id).sort())
      )
        throw new Error('Action does not match playbook inputs and grants');
      const run: PlaybookRun = {
        id: action.id,
        tenantId: context.tenantId,
        principalId: context.actor.id,
        activationId: activation.id,
        definitionId: version.definition.id,
        version: version.version,
        versionDigest: version.digest,
        artifactDigest: activation.artifactDigest,
        incidentId: input.incidentId,
        diagnosisRevision: input.diagnosisRevision,
        snapshot,
        snapshotDigest: deps.hash(snapshot),
        action,
        actionHash: hash,
        createdAt: deps.now().toISOString(),
      };
      // Only persisted immutable inputs may grant authority. Retrying a partial bind completes it.
      const stored = await deps.store.bind(context, run);
      if (
        playbookEligible(version.ir, stored.snapshot, deps.now().getTime()) ===
        'eligible'
      )
        await deps.provisioning.bind(context, {
          runId: run.id,
          stepId: node.id,
          tenantId: run.tenantId,
          principalId: run.principalId,
          artifactId: artifactId(activation.id),
          artifactVersion: version.version,
          artifactDigest: activation.artifactDigest,
          incidentId: run.incidentId,
          diagnosisRevision: run.diagnosisRevision,
          action: stored.action,
          eligibilityValidUntil: new Date(
            Math.min(
              ...stored.snapshot.evidence.observations.map(
                (observation) =>
                  Date.parse(observation.observedAt) +
                  version.ir.evidence.maxAgeSeconds * 1000,
              ),
            ),
          ).toISOString(),
        });

      return stored;
    },
    execute: (context: TenantContext, id: string) =>
      perform(context, id, false),
    reconcile: (context: TenantContext, id: string) =>
      perform(context, id, true),
    async get(context: TenantContext, id: string) {
      context = await authorize(context);
      const { run, version } = await load(context, id);

      return { run, version, outcomes: await deps.store.outcomes(context, id) };
    },
  };
}

export type PlaybookService = ReturnType<typeof createPlaybookService>;
