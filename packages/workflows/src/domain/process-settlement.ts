import { processInstructions } from './code-grants.js';
import type {
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from './process.js';

/**
 * Why a run was settled outside its published steps. `process_failed`: the durable run hit a
 * failure it could not recover from, such as exhausted activity retries. `process_execution_closed`:
 * its Temporal execution closed without recording a final step.
 */
export type ProcessSettlementReason =
  'process_failed' | 'process_execution_closed';

const settlementReasons = new Set<string | undefined>([
  'process_failed',
  'process_execution_closed',
]);

/** Whether an escalated output settles a run that stopped outside its published steps. */
export function isProcessSettlement(output: ProcessStepOutput) {
  return output.state === 'escalated' && settlementReasons.has(output.reason);
}

/**
 * Builds the final escalated output for a run that stopped unexpectedly, at the step it was on:
 * the step still waiting, or the one after the last completed step. Returns null when the
 * recorded outputs already end the run, so nothing is recorded twice.
 */
export function processSettlement(
  run: Pick<ProcessRun, 'id'>,
  version: Pick<ProcessWorkflowVersion, 'steps'>,
  outputs: readonly ProcessStepOutput[],
  reason: ProcessSettlementReason,
  recordedAt: string,
): ProcessStepOutput | null {
  const instructions = processInstructions(version);
  const last = outputs.at(-1);
  const position = last
    ? instructions.findIndex((step) => step.id === last.stepId)
    : -1;
  if (last && (position < 0 || last.kind === 'end')) return null;
  const step = !last
    ? instructions[0]
    : last.state === 'waiting'
      ? instructions[position]
      : last.state === 'completed'
        ? instructions[position + 1]
        : undefined;
  if (!step) return null;

  return {
    stepId: step.id,
    kind: step.kind,
    state: 'escalated',
    values: {},
    evidenceRefs: [`temporal:${run.id}:${step.id}`],
    recordedAt,
    reason,
  };
}

const failedClosures = new Set<unknown>([
  'failed',
  'cancelled',
  'terminated',
  'timed_out',
]);

/**
 * Builds the escalated output for an unfinished run when a transport's start result reports
 * that the run's execution closed without completing. A completed execution recorded its final
 * step before it closed, so a run that still looks unfinished was read before that record and
 * is left alone. Returns null when nothing should be recorded.
 */
export function closedExecutionSettlement(
  started: unknown,
  run: Pick<ProcessRun, 'id'>,
  version: Pick<ProcessWorkflowVersion, 'steps'>,
  outputs: readonly ProcessStepOutput[],
  recordedAt: string,
) {
  if (
    typeof started !== 'object' ||
    started === null ||
    !('closed' in started) ||
    !failedClosures.has(started.closed)
  )
    return null;

  return processSettlement(
    run,
    version,
    outputs,
    'process_execution_closed',
    recordedAt,
  );
}
