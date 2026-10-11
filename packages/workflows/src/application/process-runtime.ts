import { processInstructions } from '../domain/code-grants.js';
import type {
  CodeActivityResult,
  CodeStep,
  CodeTelemetry,
} from '../domain/code-step.js';
import type {
  ProcessRun,
  ProcessRunState,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';

export type ProcessActionResult =
  | { state: 'accepted'; proposalId: string; receiptId: string }
  | { state: 'awaiting_approval'; proposalId: string; decisionId: string }
  | {
      state: 'denied' | 'reconciliation_required' | 'not_executed';
      proposalId: string;
      reason: string;
    };

/** Every external read, decision, action, and verification crosses an activity boundary. */
export interface ProcessActivities {
  /** Registers or rereads persisted coordination; signals are wakeups, never evidence. */
  coordinate?(
    run: ProcessRun,
    step: Extract<ProcessStep, { kind: 'human_task' | 'event_wait' }>,
    outputs: ProcessStepOutput[],
    startedAt: string,
  ): Promise<
    | { state: 'pending'; evidenceRefs: string[] }
    | {
        state: 'completed';
        values: ProcessStepOutput['values'];
        evidenceRefs: string[];
      }
    | { state: 'cancelled'; evidenceRefs: string[]; record?: boolean }
  >;
  /** Executes a sandboxed instruction using only its published capability grants. */
  code?(
    run: ProcessRun,
    version: ProcessWorkflowVersion,
    step: CodeStep,
    outputs: ProcessStepOutput[],
  ): Promise<CodeActivityResult>;
  read(
    run: ProcessRun,
    step: Extract<ProcessStep, { kind: 'read' }>,
  ): Promise<{
    values: ProcessStepOutput['values'];
    evidenceRefs: string[];
    observedAt: string;
  }>;
  decision(
    run: ProcessRun,
    step: Extract<ProcessStep, { kind: 'approval' }>,
  ): Promise<
    { state: 'approved' | 'denied'; decisionId: string } | { state: 'pending' }
  >;
  /** Binds the exact run and step, then calls Action Admission for this action alone. */
  action(
    run: ProcessRun,
    version: ProcessWorkflowVersion,
    step: Extract<ProcessStep, { kind: 'capability' }>,
    outputs: ProcessStepOutput[],
  ): Promise<ProcessActionResult>;
  verify(
    run: ProcessRun,
    step: Extract<ProcessStep, { kind: 'verification' }>,
    outputs: ProcessStepOutput[],
  ): Promise<{
    state: 'verified' | 'failed' | 'inconclusive';
    evidenceRefs: string[];
    values: ProcessStepOutput['values'];
  }>;
  record(run: ProcessRun, output: ProcessStepOutput): Promise<void>;
}

/** Waits are durable when supplied by the Temporal workflow adapter. */
export interface ProcessClock {
  now(): string;
  wait(milliseconds: number): Promise<void>;
  decisionChanged(milliseconds: number): Promise<boolean>;
  /** Rolls over durable history at an open coordination boundary without replaying earlier effects. */
  checkpoint?(checkpoint: ProcessCheckpoint): Promise<void>;
}

/** Durable continuation state preserves the open wait's deadline and preceding immutable outputs. */
export interface ProcessCheckpoint {
  stepId: string;
  startedAt: string;
  outputs: ProcessStepOutput[];
}

export interface ProcessProgress {
  state: ProcessRunState;
  stepId: string | null;
  reason?: string;
}

/** Runs one immutable linear version; every effect and observation is recorded by an activity. */
export async function runProcess(
  run: ProcessRun,
  version: ProcessWorkflowVersion,
  activities: ProcessActivities,
  clock: ProcessClock,
  onProgress: (progress: ProcessProgress) => void = () => undefined,
  checkpoint?: ProcessCheckpoint,
): Promise<ProcessProgress> {
  if (
    run.definitionId !== version.definition.id ||
    run.version !== version.version ||
    run.versionDigest !== version.digest
  )
    throw new Error('Run is not bound to this workflow version');
  if (run.subject.kind !== version.applicability.subjectKind)
    throw new Error('Run subject does not match the workflow');
  const set = (next: ProcessProgress) => {
    onProgress(next);

    return next;
  };
  const outputs: ProcessStepOutput[] = checkpoint
    ? [...checkpoint.outputs]
    : [];
  const record = async (
    step: ProcessStep,
    state: ProcessStepOutput['state'],
    values: ProcessStepOutput['values'] = {},
    evidenceRefs: string[] = [],
    reason?: string,
    observedAt?: string,
    code?: CodeTelemetry,
  ) => {
    const output = {
      stepId: step.id,
      kind: step.kind,
      state,
      values,
      evidenceRefs,
      ...(observedAt ? { observedAt } : {}),
      recordedAt: clock.now(),
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
    };
    await activities.record(run, output);
    outputs.push(output);
  };

  let resuming = !!checkpoint;
  for (const step of processInstructions(version)) {
    if (resuming && step.id !== checkpoint?.stepId) continue;
    resuming = false;
    set({ state: 'running', stepId: step.id });
    switch (step.kind) {
      case 'code': {
        if (!activities.code) throw new Error('Code execution is unavailable');
        const deadline = Date.parse(clock.now()) + 86_400_000;
        let result = await activities.code(run, version, step, outputs);
        let waiting = false;
        while (result.state === 'awaiting_approval') {
          set({
            state: 'awaiting_decision',
            stepId: step.id,
            reason: 'policy_approval_required',
          });
          if (!waiting) {
            await record(
              step,
              'waiting',
              {},
              result.evidenceRefs,
              'policy_approval_required',
            );
            waiting = true;
          }
          if (Date.parse(clock.now()) >= deadline) {
            await record(
              step,
              'escalated',
              {},
              result.evidenceRefs,
              'policy_decision_expired',
            );

            return set({
              state: 'escalated',
              stepId: step.id,
              reason: 'policy_decision_expired',
            });
          }
          await clock.decisionChanged(30_000);
          result = await activities.code(
            run,
            version,
            step,
            outputs.filter((output) => output.stepId !== step.id),
          );
        }
        if (result.state === 'not_executed') {
          await record(
            step,
            'not_executed',
            {},
            result.evidenceRefs,
            'observe_only',
            undefined,
            result.telemetry,
          );

          return set({
            state: 'not_executed',
            stepId: step.id,
            reason: 'observe_only',
          });
        }
        await record(
          step,
          result.state === 'completed' ? 'completed' : 'escalated',
          result.values,
          result.evidenceRefs,
          result.state === 'completed' ? undefined : result.telemetry.outcome,
          undefined,
          result.telemetry,
        );
        if (result.state !== 'completed')
          return set({
            state: 'escalated',
            stepId: step.id,
            reason: result.telemetry.outcome,
          });
        break;
      }
      case 'read': {
        const result = await activities.read(run, step);
        const age = Date.parse(clock.now()) - Date.parse(result.observedAt);
        if (
          !Number.isFinite(age) ||
          age < 0 ||
          age >= version.context.maxAgeSeconds * 1000 ||
          !result.evidenceRefs.length ||
          Object.keys(result.values).length !==
            Object.keys(step.fields).length ||
          Object.entries(step.fields).some(
            ([name, type]) =>
              !Object.hasOwn(result.values, name) ||
              (result.values[name] === null
                ? 'null'
                : typeof result.values[name]) !== type,
          )
        )
          throw new Error(
            'Read output does not match its declared fields or provenance',
          );
        await record(
          step,
          'completed',
          result.values,
          result.evidenceRefs,
          undefined,
          result.observedAt,
        );
        break;
      }
      case 'condition': {
        const observed = [...outputs]
          .reverse()
          .find(
            (item) =>
              (item.kind === 'read' ||
                item.kind === 'code' ||
                item.kind === 'human_task' ||
                item.kind === 'event_wait') &&
              Object.hasOwn(item.values, step.field),
          );
        const passes =
          (observed
            ? observed.values[step.field]
            : run.context.evidence.facts[step.field]) === step.equals;
        await record(
          step,
          passes ? 'completed' : step.onFalse === 'end' ? 'ended' : 'escalated',
          { matched: passes },
          observed?.evidenceRefs ??
            run.context.evidence.observations.map((item) => item.id),
          passes ? undefined : 'condition_not_met',
        );
        if (!passes)
          return set({
            state: step.onFalse === 'end' ? 'ended' : 'escalated',
            stepId: step.id,
            reason: 'condition_not_met',
          });
        break;
      }
      case 'approval': {
        const deadline =
          Date.parse(clock.now()) + step.expiresAfterSeconds * 1000;
        let waitingRecorded = false;
        while (true) {
          const decision = await activities.decision(run, step);
          if (decision.state !== 'pending') {
            if (!decision.decisionId)
              throw new Error('Decision has no provenance');
            await record(
              step,
              decision.state === 'approved' ? 'completed' : 'denied',
              { approved: decision.state === 'approved' },
              [decision.decisionId],
            );
            if (decision.state === 'denied')
              return set({
                state: 'denied',
                stepId: step.id,
                reason: 'decision_denied',
              });
            break;
          }
          const remaining = deadline - Date.parse(clock.now());
          if (remaining <= 0) {
            await record(
              step,
              'denied',
              { approved: false },
              [`temporal:${run.id}:${step.id}`],
              'decision_expired',
            );

            return set({
              state: 'denied',
              stepId: step.id,
              reason: 'decision_expired',
            });
          }
          set({ state: 'awaiting_decision', stepId: step.id });
          if (!waitingRecorded) {
            await record(step, 'waiting', {}, [
              `temporal:${run.id}:${step.id}`,
            ]);
            waitingRecorded = true;
          }
          await clock.decisionChanged(Math.min(remaining, 30_000));
        }
        break;
      }
      case 'capability': {
        const deadline = Date.parse(clock.now()) + 86_400_000;
        let result = await activities.action(run, version, step, outputs);
        let waitingRecorded = false;
        while (result.state === 'awaiting_approval') {
          set({
            state: 'awaiting_decision',
            stepId: step.id,
            reason: 'policy_approval_required',
          });
          if (!waitingRecorded) {
            await record(
              step,
              'waiting',
              { proposalId: result.proposalId },
              [result.decisionId],
              'policy_approval_required',
            );
            waitingRecorded = true;
          }
          if (Date.parse(clock.now()) >= deadline) {
            await record(
              step,
              'escalated',
              { proposalId: result.proposalId },
              [result.decisionId],
              'policy_decision_expired',
            );

            return set({
              state: 'escalated',
              stepId: step.id,
              reason: 'policy_decision_expired',
            });
          }
          await clock.decisionChanged(30_000);
          result = await activities.action(run, version, step, outputs);
        }
        if (result.state === 'not_executed') {
          await record(
            step,
            'not_executed',
            { proposalId: result.proposalId },
            [result.proposalId],
            'observe_only',
          );

          return set({
            state: 'not_executed',
            stepId: step.id,
            reason: 'observe_only',
          });
        }
        if (result.state !== 'accepted') {
          await record(
            step,
            'escalated',
            { proposalId: result.proposalId },
            [result.proposalId],
            result.reason,
          );

          return set({
            state: 'escalated',
            stepId: step.id,
            reason: result.reason,
          });
        }
        await record(step, 'completed', { proposalId: result.proposalId }, [
          result.receiptId,
        ]);
        break;
      }
      case 'human_task':
      case 'event_wait': {
        if (!activities.coordinate)
          throw new Error('Workflow coordination is unavailable');
        const startedAt =
          checkpoint?.stepId === step.id ? checkpoint.startedAt : clock.now();
        const deadline =
          Date.parse(startedAt) +
          (step.kind === 'human_task'
            ? step.dueAfterSeconds
            : step.timeoutSeconds) *
            1000;
        let recorded = outputs.some(
          (output) => output.stepId === step.id && output.state === 'waiting',
        );
        while (true) {
          const result = await activities.coordinate(
            run,
            step,
            outputs,
            startedAt,
          );
          if (result.state === 'cancelled') {
            if (result.record)
              await record(
                step,
                'ended',
                {},
                result.evidenceRefs,
                'coordination_cancelled',
              );

            return set({
              state: 'ended',
              stepId: step.id,
              reason: 'coordination_cancelled',
            });
          }
          if (result.state === 'completed') {
            await record(step, 'completed', result.values, result.evidenceRefs);
            break;
          }
          const remaining = deadline - Date.parse(clock.now());
          if (step.kind === 'event_wait' && remaining <= 0) {
            await record(
              step,
              step.onTimeout === 'end' ? 'ended' : 'escalated',
              {},
              result.evidenceRefs,
              'event_wait_timeout',
            );

            return set({
              state: step.onTimeout === 'end' ? 'ended' : 'escalated',
              stepId: step.id,
              reason: 'event_wait_timeout',
            });
          }
          set({
            state: 'waiting',
            stepId: step.id,
            reason:
              step.kind === 'human_task' && remaining <= 0
                ? 'human_task_overdue'
                : step.kind,
          });
          if (!recorded) {
            await record(step, 'waiting', {}, result.evidenceRefs);
            recorded = true;
          }
          await clock.decisionChanged(
            remaining > 0 ? Math.min(remaining, 30_000) : 30_000,
          );
          await clock.checkpoint?.({ stepId: step.id, startedAt, outputs });
        }
        break;
      }
      case 'wait': {
        set({ state: 'waiting', stepId: step.id });
        await record(step, 'waiting', {}, [`temporal:${run.id}:${step.id}`]);
        await clock.wait(step.seconds * 1000);
        await record(step, 'completed', {}, [`temporal:${run.id}:${step.id}`]);
        break;
      }
      case 'verification': {
        const startedAt = Date.parse(clock.now());
        let result = await activities.verify(run, step, outputs);
        const evidenceRefs = new Set(result.evidenceRefs);
        for (
          let attempt = 1;
          result.state === 'inconclusive' &&
          attempt < (step.recheck?.attempts ?? 1);
          attempt++
        ) {
          const delay = (step.recheck?.intervalSeconds ?? 0) * 1000;
          if (
            Date.parse(clock.now()) + delay >=
            startedAt + step.maxDurationSeconds * 1000
          )
            break;
          await clock.wait(delay);
          result = await activities.verify(run, step, outputs);
          for (const reference of result.evidenceRefs)
            evidenceRefs.add(reference);
        }
        if (
          !result.evidenceRefs.length ||
          Object.keys(result.values).length !==
            Object.keys(step.fields).length ||
          Object.entries(step.fields).some(
            ([name, type]) =>
              !Object.hasOwn(result.values, name) ||
              (result.values[name] === null
                ? 'null'
                : typeof result.values[name]) !== type,
          )
        )
          throw new Error(
            'Verification output does not match its declared fields or provenance',
          );
        const state =
          Date.parse(clock.now()) - startedAt > step.maxDurationSeconds * 1000
            ? 'inconclusive'
            : result.state;
        await record(
          step,
          state === 'verified' ? 'completed' : state,
          result.values,
          [...evidenceRefs],
          state !== result.state ? 'verification_window_exceeded' : undefined,
        );
        if (state !== 'verified')
          return set({
            state:
              state === 'failed'
                ? 'failed_verification'
                : 'inconclusive_verification',
            stepId: step.id,
          });
        break;
      }
      case 'escalation':
        await record(
          step,
          'escalated',
          {},
          [`temporal:${run.id}:${step.id}`],
          step.reason,
        );

        return set({
          state: 'escalated',
          stepId: step.id,
          reason: step.reason,
        });
      case 'end':
        await record(step, 'completed', { outcome: step.outcome }, [
          `temporal:${run.id}:${step.id}`,
        ]);

        return set({
          state: outputs.some(
            (item) =>
              item.state === 'completed' &&
              (item.kind === 'verification' ||
                (item.code?.verifiedActions ?? 0) > 0),
          )
            ? 'verified'
            : 'ended',
          stepId: step.id,
        });
    }
  }
  throw new Error('Workflow has no terminal step');
}
