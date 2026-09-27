import {
  type ProcessActivities,
  type ProcessProgress,
  type ProcessRun,
  type ProcessWorkflowVersion,
  runProcess,
} from '@luma/workflows';
import {
  ActivityCancellationType,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';

export const processProgressQuery =
  defineQuery<ProcessProgress>('processProgress');

export const processDecisionChanged = defineSignal('processDecisionChanged');

const activities = proxyActivities<ProcessActivities>({
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});
const action = proxyActivities<Pick<ProcessActivities, 'action'>>({
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

/** Replays a version-bound process with durable waits and activity-backed effects. */
export async function processWorkflow(
  run: ProcessRun,
  version: ProcessWorkflowVersion,
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
      read: activities.read,
      decision: activities.decision,
      action: action.action,
      verify: activities.verify,
      record: activities.record,
    },
    {
      now: () => new Date().toISOString(),
      wait: sleep,
      decisionChanged: async (milliseconds) => {
        const changed = await condition(() => wake, milliseconds);
        wake = false;

        return changed;
      },
    },
    (next) => {
      progress = next;
    },
  );
}
