import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import {
  continueAsNew,
  patched,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';

import {
  membershipSuspendedFailure,
  workspaceInactiveFailure,
} from './workspace-pause.js';

const firstBackoffMs = 60_000;
const longestBackoffMs = 3_600_000;

/** Failures that repeat until a person restores the workspace, membership or permission. */
function persistent(error: unknown) {
  return (
    error instanceof ActivityFailure &&
    error.cause instanceof ApplicationFailure &&
    [
      'WorkflowRejected',
      workspaceInactiveFailure,
      membershipSuspendedFailure,
    ].includes(error.cause.type ?? '')
  );
}

/** One durable run per tenant and stall case; activities reload all ownership before every effect. */
export interface StockProtectionWorkflowInput {
  tenantId: string;
  userId: string;
  dataRegion: 'EU' | 'AU' | 'US';
  incidentId: string;
}

export interface StockProtectionActivities {
  /** Reconciles persisted actions, then processes one bounded batch. */
  stockProtectionTick(
    input: StockProtectionWorkflowInput,
  ): Promise<{ done: boolean; moreWork?: boolean }>;
}

/**
 * Keeps holds through outages and restarts, with bounded history and no effect replay in workflow code.
 * @public The Temporal bundler loads it by workflow type through `workflows.ts`.
 */
export async function stockProtectionWorkflow(
  input: StockProtectionWorkflowInput,
) {
  const activities = proxyActivities<StockProtectionActivities>({
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '5 seconds',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
    },
  });
  let backoff = firstBackoffMs;
  for (let pass = 0; pass < 500; pass++) {
    let moreWork = false;
    let rejected = false;
    try {
      const result = await activities.stockProtectionTick(input);
      if (result.done) return;
      moreWork = result.moreWork ?? false;
      backoff = firstBackoffMs;
    } catch (error) {
      // A removed permission or unavailable workspace pauses the lifecycle. The next activity
      // refreshes authority before reconciling; holds are never silently released on failure.
      // Ending the run would leave live holds unmanaged, so repeated rejections back off.
      rejected = persistent(error);
    }
    if (rejected && patched('stock-protection-rejection-backoff-v1')) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, longestBackoffMs);
    } else await sleep(moreWork ? '1 second' : '1 minute');
  }
  await continueAsNew<typeof stockProtectionWorkflow>(input);
}
