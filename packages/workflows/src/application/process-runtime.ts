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
      state: 'denied' | 'reconciliation_required';
      proposalId: string;
      reason: string;
    };

/** Every external read, decision, action, and verification crosses an activity boundary. */
export interface ProcessActivities {
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
  const outputs: ProcessStepOutput[] = [];
  const record = async (
    step: ProcessStep,
    state: ProcessStepOutput['state'],
    values: ProcessStepOutput['values'] = {},
    evidenceRefs: string[] = [],
    reason?: string,
    observedAt?: string,
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
    };
    await activities.record(run, output);
    outputs.push(output);
  };

  for (const step of version.steps) {
    set({ state: 'running', stepId: step.id });
    switch (step.kind) {
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
              item.kind === 'read' && Object.hasOwn(item.values, step.field),
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
      case 'wait': {
        set({ state: 'waiting', stepId: step.id });
        await record(step, 'waiting', {}, [`temporal:${run.id}:${step.id}`]);
        await clock.wait(step.seconds * 1000);
        await record(step, 'completed', {}, [`temporal:${run.id}:${step.id}`]);
        break;
      }
      case 'verification': {
        const startedAt = Date.parse(clock.now());
        const result = await activities.verify(run, step, outputs);
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
          result.evidenceRefs,
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
          state: version.steps.some((item) => item.kind === 'verification')
            ? 'verified'
            : 'ended',
          stepId: step.id,
        });
    }
  }
  throw new Error('Workflow has no terminal step');
}
