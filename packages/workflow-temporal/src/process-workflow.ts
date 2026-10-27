import {
  type ProcessActivities,
  type ProcessCheckpoint,
  type ProcessProgress,
  type ProcessRun,
  type ProcessWorkflowVersion,
  runProcess,
} from '@luma/workflows';
import { ApplicationFailure, TemporalFailure } from '@temporalio/common';
import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  ContinueAsNew,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  WorkflowError,
  workflowInfo,
} from '@temporalio/workflow';

import { pauseWhileInactive } from './workspace-pause.js';

const processProgressQuery = defineQuery<ProcessProgress>('processProgress');

const processDecisionChanged = defineSignal('processDecisionChanged');

// Every activity pauses the run while its workspace is suspended or closed. Database and
// provider reads retry with backoff for a bounded time, so a short outage doesn't end the run;
// when retries run out, the run settles as escalated.
const activities = pauseWhileInactive(
  proxyActivities<Required<ProcessActivities>>({
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '10 minutes',
    retry: {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumInterval: '1 minute',
    },
  }),
);
// Admission can run precondition reads, the write and verification, and a Code Step runs its
// granted actions and their verification inline; heartbeats detect a lost worker without
// retrying a slow attempt that is still running.
const effectOptions = {
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '20 seconds',
  scheduleToCloseTimeout: '15 minutes',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
} as const;
const action = pauseWhileInactive(
  proxyActivities<Pick<ProcessActivities, 'action'>>(effectOptions),
);
const code = pauseWhileInactive(
  proxyActivities<Required<Pick<ProcessActivities, 'code'>>>(effectOptions),
);

/** Ends a run with its own failure; a plain error would retry the workflow task forever. */
function failRun(error: unknown): never {
  if (
    error instanceof Error &&
    error.name === 'Error' &&
    !(error instanceof TemporalFailure)
  )
    throw ApplicationFailure.nonRetryable(error.message, 'ProcessRunRejected');
  throw error;
}

/**
 * Replays a version-bound process with durable waits and activity-backed effects.
 *
 * @public The Temporal bundler loads it by workflow type through `workflows.ts`.
 */
export async function processWorkflow(
  run: ProcessRun,
  version: ProcessWorkflowVersion,
  checkpoint?: ProcessCheckpoint,
): Promise<ProcessProgress> {
  let progress: ProcessProgress = { state: 'running', stepId: null };
  let wake = false;
  setHandler(processProgressQuery, () => progress);
  setHandler(processDecisionChanged, () => {
    wake = true;
  });

  return runProcess(
    run,
    version,
    {
      code: code.code,
      read: activities.read,
      coordinate: activities.coordinate,
      decision: activities.decision,
      actionApprovalPending: activities.actionApprovalPending,
      action: action.action,
      verify: activities.verify,
      record: activities.record,
    },
    {
      now: () => new Date().toISOString(),
      wait: sleep,
      patched,
      checkpoint: async (next) => {
        if (workflowInfo().continueAsNewSuggested)
          await continueAsNew<typeof processWorkflow>(run, version, next);
      },
      settle: async (error, record) => {
        // Continue-as-new and SDK determinism errors are not run failures.
        if (error instanceof ContinueAsNew || error instanceof WorkflowError)
          return false;
        // A cancelled run still records why it stopped.
        await CancellationScope.nonCancellable(record);

        return true;
      },
      decisionChanged: async (milliseconds) => {
        const changed = await condition(() => wake, milliseconds);
        wake = false;

        return changed;
      },
    },
    (next) => {
      progress = next;
    },
    checkpoint,
  ).catch(failRun);
}
