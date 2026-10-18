import {
  type ProcessActivities,
  type ProcessCheckpoint,
  type ProcessProgress,
  type ProcessRun,
  type ProcessWorkflowVersion,
  runProcess,
} from '@luma/workflows';
import {
  ActivityCancellationType,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

import { pauseWhileInactive } from './workspace-pause.js';

const processProgressQuery = defineQuery<ProcessProgress>('processProgress');

const processDecisionChanged = defineSignal('processDecisionChanged');

// Every activity pauses the run while its workspace is suspended or closed.
const activities = pauseWhileInactive(
  proxyActivities<Required<ProcessActivities>>({
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '30 seconds',
      maximumAttempts: 5,
    },
  }),
);
const action = pauseWhileInactive(
  proxyActivities<Pick<ProcessActivities, 'action'>>({
    // Admission can run precondition reads, the write and verification; heartbeats detect a
    // lost worker without retrying a slow attempt that is still running.
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '20 seconds',
    scheduleToCloseTimeout: '15 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '30 seconds',
      maximumAttempts: 5,
    },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  }),
);

const code = pauseWhileInactive(
  proxyActivities<Required<Pick<ProcessActivities, 'code'>>>({
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 5 },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  }),
);

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
  );
}
