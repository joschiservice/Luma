import type { ProcessRunState, ProcessStepOutput } from '../domain/process.js';
import type { WorkflowTriggerRun } from '../domain/workflow.js';

/** Presents a triggered run without implying action dispatch, approval or verified success. */
export function presentTriggerRun(
  run: WorkflowTriggerRun,
  processSteps: ProcessStepOutput[] = [],
) {
  const latest = processSteps.at(-1);
  const processState: ProcessRunState | undefined = !latest
    ? undefined
    : latest.state === 'waiting'
      ? latest.kind === 'wait'
        ? 'waiting'
        : 'awaiting_decision'
      : latest.state === 'denied'
        ? 'denied'
        : latest.state === 'failed'
          ? 'failed_verification'
          : latest.state === 'inconclusive'
            ? 'inconclusive_verification'
            : latest.state === 'ended'
              ? 'ended'
              : latest.state === 'escalated'
                ? 'escalated'
                : latest.kind === 'end'
                  ? processSteps.some(
                      (step) =>
                        step.state === 'completed' &&
                        (step.kind === 'verification' ||
                          (step.code?.verifiedActions ?? 0) > 0),
                    )
                    ? 'verified'
                    : 'ended'
                  : 'running';
  const reason =
    processState === 'verified'
      ? 'The expected result was verified.'
      : processState === 'ended'
        ? latest?.kind === 'condition'
          ? 'The current conditions do not require an action.'
          : 'The workflow finished without a verification step.'
        : processState === 'failed_verification'
          ? 'Verification found a different result. Operator review is required.'
          : processState === 'inconclusive_verification'
            ? 'Verification could not confirm the result. Operator review is required.'
            : processState === 'escalated'
              ? 'The run needs operator review.'
              : processState === 'denied'
                ? 'The decision denied this run.'
                : processState === 'waiting'
                  ? 'The workflow is waiting before its next step.'
                  : processState === 'awaiting_decision'
                    ? 'The workflow is waiting for a decision.'
                    : processState === 'running'
                      ? 'The workflow is progressing through its steps.'
                      : run.state === 'scheduled'
                        ? 'Waiting for the scheduled time.'
                        : run.state === 'cancelled'
                          ? 'The scheduled start was cancelled.'
                          : 'Trigger received. Execution requires a separate activation and admission.';

  return {
    id: run.id,
    createdAt: run.createdAt,
    version: run.version,
    versionDigest: run.versionDigest,
    activationId: run.activationId,
    evidenceKind: 'unclassified' as const,
    execution: processSteps.some(
      (step) =>
        (step.state === 'completed' && step.kind === 'capability') ||
        (step.code?.verifiedActions ?? 0) > 0,
    )
      ? 'accepted'
      : 'not_recorded',
    verification:
      processState === 'verified'
        ? 'verified'
        : processState === 'failed_verification'
          ? 'failed'
          : processState === 'inconclusive_verification'
            ? 'inconclusive'
            : 'not_verified',
    reason,
    trigger: run.trigger,
    subject: run.subject,
    actor: run.actor,
    contextDigest: run.contextDigest,
    steps: [],
    processSteps,
    ...(processState ? { processState } : {}),
    ...(processSteps.length ? {} : { triggerState: run.state }),
    triggerEvidence: run.evidence,
    triggeredAt: run.triggeredAt,
    story: {
      context: `${run.subject.kind} ${run.subject.id}`,
      decision: reason,
      action: processSteps.some(
        (step) =>
          (step.state === 'completed' && step.kind === 'capability') ||
          (step.code?.verifiedActions ?? 0) > 0,
      )
        ? 'The admitted action has a recorded receipt.'
        : 'No action has been admitted.',
      verification:
        processState === 'verified'
          ? 'The expected result was confirmed by verification.'
          : processState === 'failed_verification'
            ? 'The expected result was not observed.'
            : processState === 'inconclusive_verification'
              ? 'The expected result could not be confirmed.'
              : 'No verified result recorded.',
    },
  };
}
