import type { WorkflowDraftContent } from './draft.js';
import type { PlaybookFields, PlaybookVersion } from './playbook.js';
import type { ProcessValue } from './process.js';

/** Something a template needs before it can run, and where to fix it. */
export interface TemplateRequirement {
  label: string;
  met: boolean;
  detail: string;
  fix: {
    label: string;
    destination: 'procurement' | 'connections' | 'workflow';
  } | null;
}

/** A published definition offered in the New workflow gallery, with its readiness here. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  purpose: string;
  category:
    | 'procurement'
    | 'resolution'
    | 'inventory'
    | 'fulfillment'
    | 'orders'
    | 'returns'
    | 'connections';
  trigger: string;
  steps: string[];
  success: string;
  requirements: TemplateRequirement[];
  /** Ready when every requirement is met; blocked when one is missing. */
  readiness: 'ready' | 'blocked';
  /** Current activation status of the published definition in this workspace. */
  status: 'active' | 'inactive' | 'revoked' | 'unavailable';
  /** The guided configure flow that activates this template. */
  configure: 'replenishment' | 'resolution' | 'case';
  installed: boolean;
  version: string;
  digest: string;
}

/** Returns ready only when every requirement is met. */
export function templateReadiness(
  requirements: TemplateRequirement[],
): WorkflowTemplate['readiness'] {
  return requirements.every((item) => item.met) ? 'ready' : 'blocked';
}

/**
 * Expresses a Resolution playbook as `workflow/2` draft content so it can be customized. The
 * result is a new workflow; the published Resolution version is unchanged.
 */
export function processDraftFromPlaybook(
  playbook: Omit<PlaybookVersion, 'digest'>,
  category: string,
): WorkflowDraftContent {
  const { ir } = playbook;
  const typeOf = (value: ProcessValue) =>
    value.source === 'literal'
      ? value.value === null
        ? ('null' as const)
        : (typeof value.value as 'string' | 'number' | 'boolean')
      : value.source === 'input'
        ? ir.inputs[value.field]
        : value.source === 'evidence'
          ? ir.evidence.fields[value.field]
          : undefined;
  const checked: PlaybookFields = Object.fromEntries(
    Object.entries(ir.action.expectedPostcondition).flatMap(([name, value]) => {
      const type = typeOf(value);

      return type ? [[name, type]] : [];
    }),
  );
  const conditions = ir.eligibility.all.map((check, index) => ({
    id:
      ir.eligibility.all.length === 1
        ? ir.eligibility.id
        : `${ir.eligibility.id}-${index + 1}`,
    kind: 'condition' as const,
    field: check.field,
    equals: check.equals,
    onFalse: 'escalate' as const,
  }));

  return {
    schemaVersion: 2,
    definition: { ...playbook.definition, category },
    version: '1.0.0',
    applicability: {
      trigger: { kind: 'exception', issueType: ir.evidence.kind },
      subjectKind: ir.action.targetKind,
    },
    inputs: ir.inputs,
    context: ir.evidence,
    steps: [
      ...conditions,
      ...(ir.approval.mode === 'required'
        ? [
            {
              id: ir.approval.id,
              kind: 'approval' as const,
              forStep: ir.action.id,
              expiresAfterSeconds: 86_400,
            },
          ]
        : []),
      ir.action,
      {
        id: ir.verification.id,
        kind: 'verification',
        forStep: ir.action.id,
        evaluatorVersion: ir.verification.evaluatorVersion,
        maxDurationSeconds: ir.verification.maxDurationSeconds,
        fields: checked,
      },
      {
        id: 'finish',
        kind: 'end',
        outcome: 'Change verified',
      },
    ],
  };
}
