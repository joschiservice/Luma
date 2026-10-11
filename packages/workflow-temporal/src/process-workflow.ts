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

import { pauseWhileInactive } from './workspace-pause.js';

const processProgressQuery = defineQuery<ProcessProgress>('processProgress');

const processDecisionChanged = defineSignal('processDecisionChanged');

// Every activity pauses the run while its workspace is suspended or closed.
const activities = pauseWhileInactive(
  proxyActivities<ProcessActivities>({
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
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '5 minutes',
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
