import type { TenantContext } from '@luma/identity';
import { requireChangesAllowed, requireTenant } from '@luma/identity';
import type { ProposedAction } from '@luma/policies';
import { currentPolicyVersion } from '@luma/policies';

import type { ExecutionService } from './execution.js';

export interface ActivatedArtifact {
  id: string;
  version: string;
  digest: string;
  active: boolean;
  playbook?:
    | {
        versionDigest: string;
        policyVersion: string;
        principalIds: string[];
        connectionIds: string[];
        targetIds: string[];
      }
    | undefined;
  /** Describes authorship only. Activation and the run's principal grant authority. */
  generation: { kind: 'manual' | 'generated'; reference: string };
  steps: Record<
    string,
    {
      capability: string;
      capabilityVersion: string;
      targetKind: string;
      minimumRisk: ProposedAction['risk'];
    }
  >;
}

export interface BoundActionStep {
  runId: string;
  stepId: string;
  tenantId: string;
  principalId: string;
  artifactId: string;
  artifactVersion: string;
  artifactDigest: string;
  incidentId?: string;
  diagnosisRevision?: number;
  subject?: { kind: string; id: string };
  /** Immutable deadline derived from the playbook snapshot and evidence-age limit. */
  eligibilityValidUntil?: string;
  actionHash: string;
  action: ProposedAction;
}

export interface AdmissionReader {
  step(
    context: TenantContext,
    runId: string,
    stepId: string,
  ): Promise<BoundActionStep | null>;
  artifact(
    context: TenantContext,
    id: string,
    version: string,
  ): Promise<ActivatedArtifact | null>;
}

export interface AdmissionDependencies {
  repository: AdmissionReader;
  execution: ExecutionService;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  parseReference(input: unknown): { runId: string; stepId: string };
  parseAction(input: unknown): { action: ProposedAction; hash: string };
  /** Independently load current incident, diagnosis and tenant-owned evidence. */
  eligible(context: TenantContext, step: BoundActionStep): Promise<boolean>;
}

export class AdmissionRejected extends Error {}

const risk = { low: 0, medium: 1, high: 2 };

/** The interpreter receives this port, with a server-bound context, and serializable references only. */
export function createActionAdmission(deps: AdmissionDependencies) {
  return {
    get: deps.execution.get,
    writeMode: deps.execution.writeMode,
    reconcile: deps.execution.reconcile,
    async execute(context: TenantContext, input: unknown) {
      const reference = deps.parseReference(input);
      // Execution checks the capability's permission, or actions.execute, against a fresh
      // context at policy evaluation and again before dispatch.
      requireChangesAllowed(context);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw new AdmissionRejected('Admission principal changed');
      const step = await deps.repository.step(
        fresh,
        reference.runId,
        reference.stepId,
      );
      if (
        !step ||
        step.runId !== reference.runId ||
        step.stepId !== reference.stepId ||
        step.tenantId !== fresh.tenantId ||
        step.principalId !== fresh.actor.id
      )
        throw new AdmissionRejected('Action step not found');
      const artifact = await deps.repository.artifact(
        fresh,
        step.artifactId,
        step.artifactVersion,
      );
      const permission = artifact?.steps[step.stepId];
      const { action, hash } = deps.parseAction(step.action);
      requireTenant(fresh, action.tenantId);
      if (
        !artifact?.active ||
        artifact.id !== step.artifactId ||
        artifact.version !== step.artifactVersion ||
        artifact.digest !== step.artifactDigest ||
        !permission ||
        hash !== step.actionHash ||
        action.proposedBy.id !== step.principalId ||
        action.proposedBy.kind !== 'user' ||
        action.capability !== permission.capability ||
        action.capabilityVersion !== permission.capabilityVersion ||
        action.target.kind !== permission.targetKind ||
        risk[action.risk] < risk[permission.minimumRisk]
      )
        throw new AdmissionRejected('Action does not match activated artifact');
      if (
        artifact.playbook &&
        (artifact.playbook.policyVersion !== currentPolicyVersion ||
          !artifact.playbook.principalIds.includes(fresh.actor.id) ||
          !artifact.playbook.connectionIds.includes(action.connectionId) ||
          !artifact.playbook.targetIds.includes(action.target.id))
      )
        throw new AdmissionRejected(
          'Action exceeds playbook activation grants',
        );
      const admission = {
        runId: step.runId,
        stepId: step.stepId,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        ...(step.incidentId
          ? {
              incidentId: step.incidentId,
              diagnosisRevision: step.diagnosisRevision!,
            }
          : { subject: step.subject! }),
        generation: artifact.generation,
      };
      // Replays may recover an already reserved effect even after evidence expires.
      const previous = await deps.execution.get(fresh, action.id);
      if (previous && 'record' in previous) {
        const binding = previous.record.admission;
        if (
          previous.record.actionHash !== hash ||
          !binding ||
          binding.runId !== step.runId ||
          binding.stepId !== step.stepId ||
          binding.artifactDigest !== artifact.digest
        )
          throw new AdmissionRejected('Execution admission binding conflicts');

        return previous;
      }
      if (previous?.state === 'not_executed') return previous;
      const stillEligible = async () => {
        const current = await deps.refreshContext(fresh);
        requireTenant(current, fresh.tenantId);
        if (current.actor.id !== step.principalId) return false;
        const active = await deps.repository.artifact(
          current,
          artifact.id,
          artifact.version,
        );

        return (
          !!active?.active &&
          active.digest === artifact.digest &&
          (await deps.eligible(current, step)) &&
          (!artifact.playbook ||
            (Number.isFinite(Date.parse(step.eligibilityValidUntil ?? '')) &&
              deps.now().getTime() < Date.parse(step.eligibilityValidUntil!)))
        );
      };
      if (!(await stillEligible()))
        throw new AdmissionRejected('Action is no longer eligible');

      return deps.execution.execute(fresh, action, admission, stillEligible);
    },
  };
}

export type ActionAdmission = Omit<
  ReturnType<typeof createActionAdmission>,
  'writeMode'
> & {
  /** Persistent composition provides mode reads; isolated test ports may omit them. */
  writeMode?: ReturnType<typeof createActionAdmission>['writeMode'];
};
