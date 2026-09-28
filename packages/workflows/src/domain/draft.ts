import type { CodeStep } from './code-step.js';
import type { PlaybookFields } from './playbook.js';
import type { ProcessStep, ProcessWorkflowVersion } from './process.js';
import type { WorkflowDefinition, WorkflowTrigger } from './workflow.js';

/** How the latest content of a draft was authored. Every mode edits the same content. */
export type AuthoringMode = 'template' | 'visual' | 'code' | 'language';

/** A Code Step before publication binds its runtime and artifact digest. */
export type DraftCodeStep = Omit<CodeStep, 'artifactDigest' | 'runtime'>;

export type DraftStep = Exclude<ProcessStep, CodeStep> | DraftCodeStep;

/** Authored `workflow/2` content. It may be incomplete until validation passes. */
export interface WorkflowDraftContent {
  schemaVersion: 2;
  definition: WorkflowDefinition;
  version: string;
  applicability: { trigger: WorkflowTrigger; subjectKind: string };
  inputs: PlaybookFields;
  context: { kind: string; fields: PlaybookFields; maxAgeSeconds: number };
  steps: DraftStep[];
}

/** The published version a draft continues, when it edits an existing workflow. */
export interface DraftOrigin {
  definitionId: string;
  version: string;
  digest: string;
}

/** A mutable, tenant-owned authoring record. Drafts never run and grant no authority. */
export interface WorkflowDraft {
  id: string;
  tenantId: string;
  revision: number;
  state: 'draft' | 'published' | 'discarded';
  mode: AuthoringMode;
  content: WorkflowDraftContent;
  /** Code view text, kept verbatim when the code view made the latest edit. */
  codeView: string | null;
  basedOn: DraftOrigin | null;
  authorId: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  published: {
    version: string;
    digest: string;
    publishedAt: string;
    publishedBy: string;
  } | null;
}

/** A validation finding that points at the step and field an author must change. */
export interface WorkflowDiagnostic {
  /** Errors block publication. Warnings describe limits that do not. */
  severity: 'error' | 'warning';
  code: string;
  /** Position in the step list, or null for workflow-level settings. */
  stepIndex: number | null;
  stepId: string | null;
  /** Dotted path within the step or workflow, for example `parameters.quantity`. */
  field: string | null;
  /** Plain-language explanation for the author. */
  message: string;
  /** Technical explanation for reviewers and support. */
  detail: string;
}

/** Creates a workflow-level or step-level diagnostic with consistent defaults. */
export function diagnostic(
  code: string,
  message: string,
  detail: string,
  at: {
    stepIndex?: number | null;
    stepId?: string | null;
    field?: string | null;
    severity?: WorkflowDiagnostic['severity'];
  } = {},
): WorkflowDiagnostic {
  return {
    severity: at.severity ?? 'error',
    code,
    stepIndex: at.stepIndex ?? null,
    stepId: at.stepId ?? null,
    field: at.field ?? null,
    message,
    detail,
  };
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Compares `major.minor.patch` versions. Returns null when either is not a valid version. */
export function compareVersions(left: string, right: string): number | null {
  const a = semver.exec(left);
  const b = semver.exec(right);
  if (!a || !b) return null;
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }

  return 0;
}

/** Suggests the next minor version after the highest published version. */
export function nextVersion(published: string[]): string {
  const latest = published
    .filter((item) => semver.test(item))
    .sort((a, b) => compareVersions(b, a) ?? 0)[0];
  if (!latest) return '1.0.0';
  const [major, minor] = latest.split('.').map(Number);

  return `${major}.${minor! + 1}.0`;
}

/** Removes published bindings so a version can be edited as a new draft. */
export function draftFromVersion(
  version: ProcessWorkflowVersion,
): WorkflowDraftContent {
  return {
    schemaVersion: 2,
    definition: version.definition,
    version: version.version,
    applicability: version.applicability,
    inputs: version.inputs,
    context: version.context,
    steps: version.steps.map((step) =>
      step.kind === 'code'
        ? {
            id: step.id,
            kind: 'code',
            source: step.source,
            fields: step.fields,
            grants: step.grants,
            limits: step.limits,
          }
        : step,
    ),
  };
}
