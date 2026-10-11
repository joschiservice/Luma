import type {
  CodeActivityResult,
  CodeCall,
  CodeRunner,
  CodeStep,
} from '../domain/code-step.js';
import { CodeRequestStopped } from '../domain/code-step.js';
import type {
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
import type { ProcessActivities } from './process-runtime.js';

/** Stores immutable replies and terminal outcomes under an exact run, step and input binding. */
export interface CodeJournal {
  result(
    run: ProcessRun,
    step: CodeStep,
    input: unknown,
  ): Promise<CodeActivityResult | null>;
  calls(run: ProcessRun, step: CodeStep): Promise<CodeCall[]>;
  append(
    run: ProcessRun,
    step: CodeStep,
    index: number,
    call: CodeCall,
  ): Promise<CodeCall>;
  finish(
    run: ProcessRun,
    step: CodeStep,
    input: unknown,
    result: CodeActivityResult,
  ): Promise<CodeActivityResult>;
  cancelled(run: ProcessRun, step: CodeStep): Promise<boolean>;
}

/** Replays code against recorded capability replies; every new effect enters the existing action activity. */
export function createCodeActivity(deps: {
  runner: CodeRunner;
  journal: CodeJournal;
  activities: Pick<ProcessActivities, 'read' | 'action' | 'verify'>;
  authorize(
    run: ProcessRun,
    version: ProcessWorkflowVersion,
    step: CodeStep,
  ): Promise<void>;
}) {
  return async (
    run: ProcessRun,
    version: ProcessWorkflowVersion,
    step: CodeStep,
    outputs: ProcessStepOutput[],
  ): Promise<CodeActivityResult> => {
    await deps.authorize(run, version, step);
    const input = {
      inputs: run.context.inputs,
      evidence: run.context.evidence.facts,
      steps: Object.fromEntries(
        outputs
          .filter((o) => o.state === 'completed')
          .map((o) => [o.stepId, o.values]),
      ),
    };
    const existing = await deps.journal.result(run, step, input);
    if (existing) return existing;
    const saved = await deps.journal.calls(run, step);
    const evidence = new Set(saved.flatMap((call) => call.evidenceRefs));
    const callOutputs = [...outputs];
    let index = 0;
    let waiting = false;
    let observeOnly = false;
    let verifiedActions = saved.filter((call) =>
      version.steps.some(
        (node) => node.id === call.grant && node.kind === 'capability',
      ),
    ).length;
    const stop = new AbortController();
    let pollingFailed = false;
    let polling: Promise<void> | undefined;
    const poll = setInterval(() => {
      if (polling) return;
      polling = deps.journal
        .cancelled(run, step)
        .then((cancelled) => {
          if (cancelled) stop.abort();
        })
        .catch(() => {
          pollingFailed = true;
          stop.abort();
        })
        .finally(() => {
          polling = undefined;
        });
    }, 200);
    try {
      if (await deps.journal.cancelled(run, step)) stop.abort();
      const result = await deps.runner.run(step, input, {
        now: run.createdAt,
        signal: stop.signal,
        async request(grant) {
          await deps.authorize(run, version, step);
          if (stop.signal.aborted || (await deps.journal.cancelled(run, step)))
            throw new CodeRequestStopped('cancelled');
          if (!step.grants.includes(grant))
            throw new CodeRequestStopped('capability_denied');
          const position = index++;
          const replay = saved[position];
          if (replay && replay.grant !== grant)
            throw new CodeRequestStopped('capability_denied');
          const node = version.steps.find((item) => item.id === grant);
          if (!node || (node.kind !== 'read' && node.kind !== 'capability'))
            throw new CodeRequestStopped('capability_denied');
          let call = replay;
          if (!call) {
            if (node.kind === 'read') {
              const read = await deps.activities.read(run, node);
              const age = Date.now() - Date.parse(read.observedAt);
              if (
                !Number.isFinite(age) ||
                age < 0 ||
                age >= version.context.maxAgeSeconds * 1000 ||
                !read.evidenceRefs.length ||
                Object.keys(read.values).length !==
                  Object.keys(node.fields).length ||
                Object.entries(node.fields).some(
                  ([key, type]) =>
                    !Object.hasOwn(read.values, key) ||
                    (read.values[key] === null
                      ? 'null'
                      : typeof read.values[key]) !== type,
                )
              )
                throw new CodeRequestStopped('invalid_output');
              call = {
                grant,
                value: read.values,
                evidenceRefs: read.evidenceRefs,
              };
            } else {
              const action = await deps.activities.action(
                run,
                version,
                node,
                callOutputs,
              );
              if (action.state === 'not_executed') {
                observeOnly = true;
                evidence.add(action.proposalId);
                throw new CodeRequestStopped('capability_denied');
              }
              if (action.state === 'awaiting_approval') {
                waiting = true;
                evidence.add(action.decisionId);
                throw new CodeRequestStopped('capability_denied');
              }
              if (action.state !== 'accepted')
                throw new CodeRequestStopped('capability_denied');
              const verification = version.steps.find(
                (item) =>
                  item.kind === 'verification' && item.forStep === node.id,
              );
              if (!verification || verification.kind !== 'verification')
                throw new CodeRequestStopped('capability_denied');
              const actionOutput: ProcessStepOutput = {
                stepId: node.id,
                kind: 'capability',
                state: 'completed',
                values: { proposalId: action.proposalId },
                evidenceRefs: [action.receiptId],
                recordedAt: run.createdAt,
              };
              const verificationStarted = Date.now();
              const verified = await deps.activities.verify(run, verification, [
                ...callOutputs,
                actionOutput,
              ]);
              if (
                verified.state !== 'verified' ||
                Date.now() - verificationStarted >
                  verification.maxDurationSeconds * 1000 ||
                !verified.evidenceRefs.length ||
                Object.keys(verified.values).length !==
                  Object.keys(verification.fields).length ||
                Object.entries(verification.fields).some(
                  ([key, type]) =>
                    !Object.hasOwn(verified.values, key) ||
                    (verified.values[key] === null
                      ? 'null'
                      : typeof verified.values[key]) !== type,
                )
              )
                throw new CodeRequestStopped('capability_denied');
              call = {
                grant,
                value: verified.values,
                evidenceRefs: [action.receiptId, ...verified.evidenceRefs],
              };
            }
            call = await deps.journal.append(run, step, position, call);
          }
          if (node.kind === 'capability' && !replay) verifiedActions++;
          call.evidenceRefs.forEach((ref) => evidence.add(ref));
          if (node.kind === 'read')
            callOutputs.push({
              stepId: node.id,
              kind: 'read',
              state: 'completed',
              values: call.value as ProcessStepOutput['values'],
              evidenceRefs: call.evidenceRefs,
              recordedAt: run.createdAt,
            });

          return call.value;
        },
      });
      clearInterval(poll);
      await polling;
      if (pollingFailed)
        throw new Error(
          'Code cancellation status unavailable; retry the activity',
        );
      const outcome: CodeActivityResult = {
        ...result,
        telemetry: { ...result.telemetry, verifiedActions },
        state: observeOnly
          ? 'not_executed'
          : waiting &&
              !['cancelled', 'resource_limit'].includes(
                result.telemetry.outcome,
              )
            ? 'awaiting_approval'
            : result.telemetry.outcome === 'completed'
              ? 'completed'
              : 'failed',
        evidenceRefs: [step.artifactDigest, ...evidence],
      };
      if (
        waiting &&
        !['cancelled', 'resource_limit'].includes(result.telemetry.outcome)
      )
        return outcome;
      if (result.telemetry.outcome === 'completed' && index < saved.length)
        throw new Error('Code replay omitted a recorded request');

      return deps.journal.finish(run, step, input, outcome);
    } finally {
      clearInterval(poll);
      stop.abort();
    }
  };
}
