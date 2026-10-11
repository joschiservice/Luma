import type { PlaybookVersion } from '../domain/playbook.js';
import type { PlaybookRunView } from '../domain/playbook-library.js';
import type { WorkflowRun } from '../domain/workflow.js';
import type { PlaybookOutcome, PlaybookRun } from './playbook.js';

/** Projects a persisted Resolution run into the subject-based Workflow contract. */
export function resolutionWorkflowRun(
  run: PlaybookRun,
  version: PlaybookVersion,
): WorkflowRun {
  return {
    id: run.id,
    tenantId: run.tenantId,
    definitionId: run.definitionId,
    version: run.version,
    versionDigest: run.versionDigest,
    activationId: run.activationId,
    artifactDigest: run.artifactDigest,
    trigger: { kind: 'exception', issueType: version.ir.evidence.kind },
    subject: { kind: run.action.target.kind, id: run.action.target.id },
    actor: { kind: 'user', id: run.principalId },
    context: run.snapshot,
    contextDigest: run.snapshotDigest,
    createdAt: run.createdAt,
    resolution: {
      incidentId: run.incidentId,
      diagnosisRevision: run.diagnosisRevision,
    },
  };
}

/** Keeps execution and verification distinct; authorship alone cannot establish live success. */
export function presentResolutionRun(
  run: PlaybookRun,
  version: PlaybookVersion,
  outcome?: PlaybookOutcome | null,
): PlaybookRunView {
  return {
    id: run.id,
    incidentId: run.incidentId,
    createdAt: run.createdAt,
    version: run.version,
    versionDigest: run.versionDigest,
    activationId: run.activationId,
    evidenceKind:
      version.provenance.kind === 'pilot' ? 'pilot' : 'unclassified',
    execution:
      outcome?.execution?.state ??
      (outcome?.state === 'not_executed'
        ? 'not_executed'
        : outcome?.state === 'awaiting_approval'
          ? 'awaiting_approval'
          : outcome?.state === 'denied'
            ? 'denied'
            : 'not_recorded'),
    verification:
      outcome?.state === 'verified'
        ? 'verified'
        : outcome?.reason === 'verification_failed'
          ? 'failed'
          : outcome?.reason === 'verification_inconclusive' ||
              outcome?.reason === 'verification_window_exceeded'
            ? 'inconclusive'
            : 'not_verified',
    reason: outcome?.reason ?? 'No outcome recorded',
  };
}

/** Describes recorded decisions without inferring approval or success from a dispatched action. */
export function presentResolutionStory(
  run: PlaybookRun,
  version: PlaybookVersion,
  outcome?: PlaybookOutcome | null,
) {
  const view = presentResolutionRun(run, version, outcome);
  const decisions: Record<PlaybookOutcome['reason'], string> = {
    observe_only:
      'Not executed: observe-only. Would run when writes are enabled.',
    approval_required:
      'Waiting for someone else who can approve changes to decide on the proposed change.',
    verified: 'The expected correction was confirmed by verification.',
    policy_denied: 'Policy denied the proposed change.',
    ineligible: 'The evidence did not meet the workflow conditions.',
    stale_evidence: 'The evidence expired. A fresh investigation is required.',
    verification_failed:
      'The observed result did not match the expected correction. Operator review is required.',
    verification_inconclusive:
      'The result could not be confirmed. Operator review is required.',
    verification_window_exceeded:
      'Verification did not finish within the allowed window. Operator review is required.',
    activation_unavailable: 'The selected activation is no longer available.',
    admission_rejected:
      'The action did not pass the current authorization and safety checks.',
    reconciliation_required:
      'The action state is uncertain. Reconcile it before considering another change.',
  };

  const facts = run.snapshot?.evidence.facts;
  const context = [
    facts?.diagnosisReady === true
      ? 'The diagnosis was ready for a proposed correction.'
      : facts?.diagnosisReady === false
        ? 'The diagnosis was not ready for a proposed correction.'
        : null,
    facts?.methodMapped === true
      ? 'An approved shipping-method mapping was available.'
      : facts?.methodMapped === false
        ? 'No approved shipping-method mapping was available.'
        : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    context:
      context ||
      `Diagnosis revision ${run.diagnosisRevision}. Open the issue to inspect the investigation evidence.`,
    decision: outcome ? decisions[outcome.reason] : 'No decision recorded yet.',
    action:
      version.ir.action.capability === 'orders.shipping-method.write'
        ? 'Set the order shipping method to the mapped method.'
        : `Apply ${version.ir.action.capability} to the selected ${version.ir.action.targetKind}.`,
    verification:
      view.verification === 'verified'
        ? 'The expected correction was verified. This does not establish any later business outcome.'
        : view.verification === 'failed'
          ? 'The expected correction was not observed.'
          : view.verification === 'inconclusive'
            ? 'The expected correction could not be confirmed.'
            : 'The expected correction has not been verified.',
  };
}
