import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  ExceptionActivities,
  ExceptionWorkflowInput,
  WorkflowProgress,
} from '../application/runtime.js';

export const progressQuery = defineQuery<WorkflowProgress>('progress');
/** A wake-up hint only. The execution service reads the persisted approval. */
export const approvalChanged = defineSignal('approvalChanged');
const activities = proxyActivities<ExceptionActivities>({
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

export async function exceptionWorkflow(
  input: ExceptionWorkflowInput,
): Promise<WorkflowProgress> {
  let progress: WorkflowProgress = { phase: 'detecting' };
  let wake = false;
  let dispatched = false;
  setHandler(progressQuery, () => progress);
  setHandler(approvalChanged, () => {
    wake = true;
  });
  const finish = (phase: WorkflowProgress['phase'], reason?: string) => {
    progress = { ...progress, phase, ...(reason ? { reason } : {}) };
    return progress;
  };
  try {
    const exceptionId = await activities.detect(input);
    if (!exceptionId) return finish('no_incident');
    progress = { phase: 'diagnosing', exceptionId };
    let diagnosis = await activities.diagnose(input, exceptionId);
    for (
      let attempt = 1;
      attempt < 5 &&
      (diagnosis.status === 'pending' || diagnosis.status === 'failed');
      attempt++
    ) {
      const delay = diagnosis.retryAfter
        ? Date.parse(diagnosis.retryAfter) - Date.now()
        : 1000;
      if (!Number.isFinite(delay) || delay > 86_400_000)
        return finish('escalated', 'diagnosis_backoff_exceeded');
      await sleep(Math.max(1000, delay));
      diagnosis = await activities.diagnose(input, exceptionId);
    }
    if (diagnosis.verificationRequired) {
      finish('verifying');
      return (await activities.verify(input, exceptionId))
        ? finish('resolved')
        : finish('escalated', 'verification_requires_review');
    }
    if (diagnosis.status !== 'ready')
      return finish('escalated', 'diagnosis_requires_review');
    finish('proposing');
    const proposal = await activities.propose(
      input,
      exceptionId,
      diagnosis.revision,
    );
    if (!proposal) return finish('escalated', 'manual_intervention_required');
    progress = { ...progress, proposalId: proposal.id };
    const approvalDeadline = Math.min(
      Date.parse(proposal.expiresAt),
      Date.now() + 86_400_000,
    );
    let result;
    while (true) {
      if (!Number.isFinite(approvalDeadline) || Date.now() >= approvalDeadline)
        return finish('denied', 'proposal_expired');
      finish('executing');
      // On cancellation, an activity may have dispatched before recording its result.
      dispatched = true;
      result = await activities.execute(input, exceptionId, proposal);
      if (result.state !== 'approval_required') break;
      dispatched = false;
      progress = {
        ...progress,
        phase: 'awaiting_approval',
        decisionId: result.decisionId,
      };
      // Polling recovers an approval committed before a lost notification.
      await condition(
        () => wake,
        Math.min(30_000, Math.max(1, approvalDeadline - Date.now())),
      );
      wake = false;
    }
    if (result.state === 'reconciliation_required') {
      finish('reconciling');
      result = await activities.reconcile(input, proposal.id);
    }
    if (result.state === 'denied') return finish('denied', 'policy_denied');
    if (result.state !== 'succeeded')
      return finish('escalated', 'execution_requires_review');
    finish('verifying');
    return (await activities.verify(input, exceptionId))
      ? finish('resolved')
      : finish('escalated', 'verification_requires_review');
  } catch (error) {
    if (isCancellation(error)) {
      if (dispatched && progress.proposalId) {
        await CancellationScope.nonCancellable(async () => {
          try {
            await activities.reconcile(input, progress.proposalId!);
          } catch {
            /* Recovery remains visible in execution's durable attempt. */
          }
        });
      }
      throw error;
    }
    if (dispatched && progress.proposalId) {
      try {
        finish('reconciling');
        const recovered = await activities.reconcile(
          input,
          progress.proposalId,
        );
        if (
          recovered.state === 'succeeded' &&
          progress.exceptionId &&
          (await activities.verify(input, progress.exceptionId))
        )
          return finish('resolved');
      } catch {
        /* Leave ambiguous effects for human review. */
      }
    }
    // Error text may contain provider data; expose only a stable operational reason.
    return finish('escalated', 'activity_failed');
  }
}
