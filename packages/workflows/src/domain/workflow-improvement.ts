import { canonicalJson } from '@luma/platform';

import type { WorkflowDiagnostic, WorkflowDraftContent } from './draft.js';
import { diagnostic } from './draft.js';
import type { PlaybookScalar } from './playbook.js';
import type {
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from './process.js';

/** Retained, independently verified facts supplied by an authorized domain reader. */
export interface ImprovementEvidence {
  incidentId: string;
  runId: string;
  pattern: 'inventory_mismatch' | 'sync_failure';
  subjectId: string;
  evidenceRefs: string[];
  evaluatorVersion: string;
  verifiedAt: string;
  artifactDigest: string;
  repairCodes: string[];
  humanInterventions: number;
}

/** Read-only discovery queue; choosing a source never generates or promotes a workflow. */
export interface ImprovementDiscoveryGroup {
  id: string;
  pattern: 'inventory_mismatch' | 'sync_failure';
  artifact: { id: string; version: string; digest: string };
  environment: 'live' | 'synthetic' | 'unknown';
  verifiedIncidents: number;
  humanInterventions: number;
  humanEdits: number;
  recordedEffortSeconds: number | null;
  recurrences: number;
  eligibleForProposal: boolean;
  productionPromotion: 'blocked';
  missingEvidence: string[];
  sources: { incidentId: string; runId: string; subjectId: string }[];
}

/** Review information derived by the server, never accepted from model output. */
export interface ImprovementReview {
  evidence: ImprovementEvidence;
  baselineDigest: string;
  candidateDigest: string;
  schemaVersion: 'workflow/2';
  requiredCapabilities: string[];
  rollout: { kind: 'selected_subjects'; subjectIds: string[] };
  humanSteps: string[];
  coverage: 'not_evaluated' | 'synthetic_passed' | 'failed';
  evaluation?: ImprovementEvaluation | undefined;
  missingCoverage: string[];
}

/** Immutable owner-retained inputs; normalized outputs remain observations, never model assertions. */
export interface HistoricalProcessCapture {
  run: ProcessRun;
  version: ProcessWorkflowVersion;
  outputs: ProcessStepOutput[];
}

/** A retained-run comparison says exactly which captured inputs could be reconstructed. */
export interface HistoricalComparison {
  source: 'retained_workflow_runs';
  assertionVersion: 'workflow-historical-invariants/1';
  passed: boolean;
  captures: {
    runId: string;
    versionDigest: string;
    contextDigest: string;
    captureDigest: string;
    baseline: EvaluationTrace;
    candidate: EvaluationTrace;
    passed: boolean;
    missingInputs: string[];
  }[];
  counterexamples: string[];
  missingInputs: string[];
}

/** Synthetic comparison is a safety check, never reconstructed historical or provider evidence. */
export interface ImprovementEvaluation {
  suiteVersion: 'workflow-improvement-safety/1';
  assertionVersion: 'workflow-improvement-invariants/1';
  fixtureHash: string;
  source: 'synthetic';
  passed: boolean;
  scenarios: {
    id: string;
    seed: number;
    baseline: EvaluationTrace;
    candidate: EvaluationTrace;
    passed: boolean;
  }[];
  counterexamples: string[];
  missingCoverage: string[];
  historical?: HistoricalComparison | undefined;
  controls?: WorkflowControlComparison | undefined;
}

/** Trusted runtime evaluation of pinned versions; models cannot supply this port or its assertions. */
export interface WorkflowControlComparison {
  suiteVersion: 'workflow-control-simulator/1';
  source: 'disposable_committed_fixture';
  tenantId: string;
  actorId: string;
  baselineDigest: string;
  candidateDigest: string;
  passed: boolean;
  versions: {
    digest: string;
    checks: { id: string; passed: boolean; applicable: boolean }[];
    actions: number;
    effects: number;
    recovery: 'committed_postgres_temporal';
  }[];
}

export interface EvaluationTrace {
  outcome: string;
  effects: {
    key: string;
    capability: string;
    parameters: Record<string, PlaybookScalar>;
  }[];
  outputs: ProcessStepOutput[];
  violations: string[];
}

const risks = { low: 0, medium: 1, high: 2 };

/**
 * Evidence-based authoring may refine behavior inside its reviewed authority envelope. New
 * capabilities, wider triggers, weaker evidence, removed approvals and new Code Steps require
 * ordinary explicit authoring instead. A generated candidate never expands authority implicitly.
 */
export function improvementDiagnostics(
  baseline: WorkflowDraftContent,
  candidate: WorkflowDraftContent,
): WorkflowDiagnostic[] {
  const errors: WorkflowDiagnostic[] = [];
  const add = (detail: string, field: string, stepId: string | null = null) =>
    errors.push(
      diagnostic(
        'improvement_authority',
        'This change exceeds the reviewed workflow scope.',
        detail,
        { field, stepId },
      ),
    );
  if (
    canonicalJson(baseline.applicability) !==
    canonicalJson(candidate.applicability)
  )
    add(
      'An improvement cannot change its subject or trigger.',
      'applicability',
    );
  if (
    candidate.context.kind !== baseline.context.kind ||
    candidate.context.maxAgeSeconds > baseline.context.maxAgeSeconds
  )
    add(
      'An improvement cannot widen evidence freshness or change its context.',
      'context',
    );
  for (const step of candidate.steps) {
    if (step.kind === 'capability') {
      const previous = baseline.steps.find((item) => item.id === step.id);
      if (
        previous?.kind !== 'capability' ||
        previous.capability !== step.capability ||
        previous.capabilityVersion !== step.capabilityVersion ||
        previous.targetKind !== step.targetKind ||
        canonicalJson(previous.expectedPostcondition) !==
          canonicalJson(step.expectedPostcondition) ||
        risks[step.minimumRisk] < risks[previous.minimumRisk]
      )
        add(
          'New or wider action authority is not allowed.',
          'capability',
          step.id,
        );
    }
    if (
      step.kind === 'read' &&
      !baseline.steps.some(
        (item) => item.kind === 'read' && item.source === step.source,
      )
    )
      add(
        'New investigative read authority is not allowed.',
        'source',
        step.id,
      );
    if (step.kind === 'code') {
      const previous = baseline.steps.find((item) => item.id === step.id);
      if (
        previous?.kind !== 'code' ||
        canonicalJson(previous) !== canonicalJson(step)
      )
        add(
          'Evidence-based improvements cannot introduce or change executable source.',
          'source',
          step.id,
        );
    }
  }
  for (const step of baseline.steps) {
    if (
      step.kind === 'approval' ||
      step.kind === 'human_task' ||
      step.kind === 'verification'
    ) {
      const next = candidate.steps.find((item) => item.id === step.id);
      if (!next || canonicalJson(next) !== canonicalJson(step))
        add(
          'Required human involvement and independent verification must be retained.',
          'steps',
          step.id,
        );
    }
  }

  return errors;
}

/** Makes coverage gaps explicit; generation and example replies do not establish safety. */
export function improvementReview(
  evidence: ImprovementEvidence,
  baselineDigest: string,
  candidate: WorkflowDraftContent,
  candidateDigest: string,
): ImprovementReview {
  return {
    evidence,
    baselineDigest,
    candidateDigest,
    schemaVersion: 'workflow/2',
    requiredCapabilities: [
      ...new Set(
        candidate.steps.flatMap((step) =>
          step.kind === 'capability'
            ? [`${step.capability}@${step.capabilityVersion}`]
            : [],
        ),
      ),
    ],
    rollout: { kind: 'selected_subjects', subjectIds: [evidence.subjectId] },
    humanSteps: candidate.steps
      .filter((step) => step.kind === 'human_task' || step.kind === 'approval')
      .map((step) => step.id),
    coverage: 'not_evaluated',
    missingCoverage: [
      'historical_replay',
      'fault_and_adversarial_comparison',
      'two_real_recurring_patterns',
    ],
  };
}
