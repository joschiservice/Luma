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
      (outcome?.state === 'awaiting_approval'
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
