import type { WorkflowTriggerRun } from '../domain/workflow.js';

/** Presents a triggered run without implying action dispatch, approval or verified success. */
export function presentTriggerRun(run: WorkflowTriggerRun) {
  const reason =
    run.state === 'scheduled'
      ? 'Waiting for the scheduled time.'
      : run.state === 'cancelled'
        ? 'The scheduled start was cancelled.'
        : 'Trigger received. Execution requires a separate activation and admission.';

  return {
    id: run.id,
    createdAt: run.createdAt,
    version: run.version,
    versionDigest: run.versionDigest,
    activationId: null,
    evidenceKind: 'unclassified' as const,
    execution: 'not_recorded',
    verification: 'not_verified',
    reason,
    trigger: run.trigger,
    subject: run.subject,
    actor: run.actor,
    contextDigest: run.contextDigest,
    steps: [],
    triggerState: run.state,
    triggerEvidence: run.evidence,
    triggeredAt: run.triggeredAt,
    story: {
      context: `${run.subject.kind} ${run.subject.id}`,
      decision: reason,
      action: 'No action has been admitted.',
      verification: 'No execution or verification result recorded.',
    },
  };
}
