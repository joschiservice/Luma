import type { TenantContext } from '@luma/identity';

import {
  draftFromVersion,
  type WorkflowDraftContent,
} from '../domain/draft.js';
import type { PlaybookScalar } from '../domain/playbook.js';
import type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
import {
  type EvaluationTrace,
  type HistoricalComparison,
  type HistoricalProcessCapture,
  improvementDiagnostics,
} from '../domain/workflow-improvement.js';
import {
  type ProcessActivities,
  type ProcessClock,
  runProcess,
} from './process-runtime.js';

/** Reconstructs observed native executions offline; missing reads, decisions or receipts never become fixtures. */
export async function compareHistoricalImprovement(request: {
  context: TenantContext;
  baseline: WorkflowDraftContent;
  candidate: ProcessWorkflowVersion;
  captures: HistoricalProcessCapture[];
  hash(value: unknown): string;
}): Promise<HistoricalComparison> {
  const captures: HistoricalComparison['captures'] = [];
  for (const capture of request.captures) {
    const missing = new Set<string>();
    if (
      capture.run.tenantId !== request.context.tenantId ||
      capture.run.versionDigest !== capture.version.digest ||
      capture.run.contextDigest !== request.hash(capture.run.context) ||
      request.hash(draftFromVersion(capture.version)) !==
        request.hash(request.baseline)
    )
      missing.add('capture_binding');
    const terminal = capture.outputs.at(-1);
    if (
      !terminal ||
      !['end', 'escalation', 'condition', 'approval', 'verification'].includes(
        terminal.kind,
      ) ||
      terminal.state === 'waiting'
    )
      missing.add('terminal_outcome');

    async function exercise(
      version: ProcessWorkflowVersion,
    ): Promise<EvaluationTrace> {
      let time = Date.parse(capture.run.createdAt);
      const trace: EvaluationTrace = {
        outcome: 'unknown',
        effects: [],
        outputs: [],
        violations: [],
      };
      const run: ProcessRun = {
        ...capture.run,
        definitionId: version.definition.id,
        version: version.version,
        versionDigest: version.digest,
      };
      const observed = (step: ProcessStep): ProcessStepOutput => {
        const output = capture.outputs
          .filter((item) => item.stepId === step.id && item.state !== 'waiting')
          .at(-1);
        if (
          !output ||
          output.kind !== step.kind ||
          !output.evidenceRefs.length ||
          !Number.isFinite(Date.parse(output.recordedAt))
        ) {
          missing.add(`step:${step.id}`);
          throw new Error('missing_captured_step');
        }
        time = Math.max(time, Date.parse(output.recordedAt));

        return output;
      };
      const scalar = (
        value: {
          source: string;
          field?: string;
          stepId?: string;
          value?: PlaybookScalar;
        },
        outputs: ProcessStepOutput[],
      ): PlaybookScalar | undefined =>
        value.source === 'literal'
          ? value.value
          : value.source === 'input'
            ? run.context.inputs[value.field!]
            : value.source === 'evidence'
              ? run.context.evidence.facts[value.field!]
              : outputs.find((item) => item.stepId === value.stepId)?.values[
                  value.field!
                ];
      const activities: ProcessActivities = {
        code: async (_run, _version, step) => {
          missing.add(`unsupported_code_capture:${step.id}`);
          throw new Error('unsupported_code_capture');
        },
        coordinate: async (_run, step) => {
          missing.add(`unsupported_coordination_capture:${step.id}`);
          throw new Error('unsupported_coordination_capture');
        },
        read: async (_run, step) => {
          const output = observed(step);
          if (
            output.state !== 'completed' ||
            !output.observedAt ||
            !Number.isFinite(Date.parse(output.observedAt))
          ) {
            missing.add(`read:${step.id}`);
            throw new Error('incomplete_captured_read');
          }

          return {
            values: structuredClone(output.values),
            evidenceRefs: output.evidenceRefs,
            observedAt: output.observedAt,
          };
        },
        decision: async (_run, step) => {
          const output = observed(step);
          if (
            output.values.approved !== (output.state === 'completed') ||
            !['completed', 'denied'].includes(output.state)
          ) {
            missing.add(`decision:${step.id}`);
            throw new Error('incomplete_captured_decision');
          }

          return {
            state: output.state === 'completed' ? 'approved' : 'denied',
            decisionId: output.evidenceRefs[0]!,
          };
        },
        action: async (acting, _version, step, outputs) => {
          if (acting.tenantId !== request.context.tenantId) {
            trace.violations.push('tenant_isolation');
            throw new Error('foreign_tenant');
          }
          const output = observed(step);
          if (
            output.state !== 'completed' ||
            typeof output.values.proposalId !== 'string'
          ) {
            missing.add(`receipt:${step.id}`);
            throw new Error('incomplete_captured_action');
          }
          const parameters: Record<string, PlaybookScalar> = {};
          for (const [field, value] of Object.entries(step.parameters)) {
            const resolved = scalar(value, outputs);
            if (resolved === undefined) throw new Error('missing_parameter');
            parameters[field] = resolved;
          }
          trace.effects.push({
            key: `${acting.tenantId}:${acting.id}:${step.id}`,
            capability: step.capability,
            parameters,
          });

          return {
            state: 'accepted',
            proposalId: output.values.proposalId,
            receiptId: output.evidenceRefs[0]!,
          };
        },
        verify: async (_run, step, outputs) => {
          const requestedAt = time;
          const output = observed(step);
          if (Date.parse(output.recordedAt) < requestedAt) {
            missing.add(`verification_time:${step.id}`);
            throw new Error('uncaptured_later_verification');
          }
          if (!['completed', 'failed', 'inconclusive'].includes(output.state)) {
            missing.add(`verification:${step.id}`);
            throw new Error('incomplete_captured_verification');
          }
          const action = version.steps.find((item) => item.id === step.forStep);
          const matches =
            action?.kind === 'capability' &&
            Object.entries(action.expectedPostcondition).every(
              ([field, value]) =>
                output.values[field] === scalar(value, outputs),
            );

          return {
            state:
              output.state === 'inconclusive'
                ? 'inconclusive'
                : output.state === 'completed' && matches
                  ? 'verified'
                  : 'failed',
            values: output.values,
            evidenceRefs: output.evidenceRefs,
          };
        },
        record: async (_run, output) => {
          trace.outputs.push(output);
        },
      };
      const clock: ProcessClock = {
        now: () => new Date(time).toISOString(),
        wait: async (ms) => {
          time += ms;
        },
        decisionChanged: async () => {
          throw new Error('missing_captured_decision');
        },
      };
      try {
        trace.outcome = (
          await runProcess(run, version, activities, clock)
        ).state;
      } catch {
        trace.outcome = 'failed';
        trace.violations.push('unreconstructed_execution');
      }

      return trace;
    }

    const baseline = await exercise(capture.version);
    const candidate = await exercise(request.candidate);
    // Replaying the recorded baseline must reproduce its branch decisions and observed terminal state.
    for (const output of baseline.outputs) {
      if (output.state === 'waiting') continue;
      const original = capture.outputs
        .filter(
          (item) => item.stepId === output.stepId && item.state !== 'waiting',
        )
        .at(-1);
      if (
        !original ||
        output.state !== original.state ||
        request.hash(output.values) !== request.hash(original.values)
      )
        missing.add(`baseline_divergence:${output.stepId}`);
    }
    const authority = improvementDiagnostics(
      request.baseline,
      draftFromVersion(request.candidate),
    );
    const passed =
      !missing.size &&
      !authority.length &&
      !baseline.violations.length &&
      !candidate.violations.length &&
      baseline.outcome === candidate.outcome &&
      request.hash(baseline.effects) === request.hash(candidate.effects);
    captures.push({
      runId: capture.run.id,
      versionDigest: capture.version.digest,
      contextDigest: capture.run.contextDigest,
      captureDigest: request.hash(capture),
      baseline,
      candidate,
      passed,
      missingInputs: [...missing].sort(),
    });
  }

  return {
    source: 'retained_workflow_runs',
    assertionVersion: 'workflow-historical-invariants/1',
    passed: captures.length > 0 && captures.every((item) => item.passed),
    captures,
    counterexamples: captures
      .filter((item) => !item.passed && !item.missingInputs.length)
      .map((item) => item.runId),
    missingInputs: captures.length
      ? [...new Set(captures.flatMap((item) => item.missingInputs))]
      : ['matching_native_workflow_run'],
  };
}
