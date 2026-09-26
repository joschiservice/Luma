import { z } from 'zod';

import type { WorkflowSource, WorkflowVersion } from '../domain/workflow.js';
import { compilePlaybook, playbookHash } from './playbooks/schema.js';

const text = z.string().min(1).max(200);
const source = z
  .object({
    schemaVersion: z.literal(1),
    definition: z
      .object({
        id: text,
        name: text,
        intent: z.string().min(1).max(2000),
        category: text,
      })
      .strict(),
    version: text,
    applicability: z
      .object({
        trigger: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('exception'), issueType: text }).strict(),
          z.object({ kind: z.literal('manual') }).strict(),
          z.object({ kind: z.literal('event'), eventType: text }).strict(),
        ]),
        subjectKind: text,
      })
      .strict(),
    inputs: z.unknown(),
    context: z.unknown(),
    steps: z.array(z.unknown()).length(5),
    policy: z
      .object({
        approval: z.enum(['policy', 'required']),
        minimumRisk: z.enum(['low', 'medium', 'high']),
      })
      .strict(),
    outcome: z
      .object({
        kind: z.literal('verified_postcondition'),
        evaluatorVersion: text,
        onUnverified: z.literal('escalate'),
      })
      .strict(),
    provenance: z.unknown(),
  })
  .strict();

/** Validates structured authoring data and computes an immutable version digest. Does not activate it. */
export function defineWorkflow(input: WorkflowSource): WorkflowVersion {
  return compileWorkflow(input);
}

/** Validates the supported linear step vocabulary; never evaluates executable source. */
export function compileWorkflow(input: unknown): WorkflowVersion {
  const envelope = source
    .extend({
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      format: z.literal('workflow/1').optional(),
    })
    .parse(input);
  const supplied = envelope.digest;
  const data = source.parse(
    Object.fromEntries(
      Object.entries(envelope).filter(
        ([key]) => key !== 'digest' && key !== 'format',
      ),
    ),
  );
  const [eligibility, action, approval, verification, recovery] = data.steps;
  const checked = compilePlaybook({
    definition: {
      id: data.definition.id,
      name: data.definition.name,
      intent: data.definition.intent,
    },
    version: data.version,
    compatibility: { interpreter: 'resolution-playbook/0', admission: 1 },
    provenance: data.provenance,
    ir: {
      schemaVersion: 1,
      inputs: data.inputs,
      evidence: data.context,
      eligibility,
      action,
      approval,
      verification,
      recovery,
    },
  });
  if (
    checked.ir.action.targetKind !== data.applicability.subjectKind ||
    checked.ir.approval.mode !== data.policy.approval ||
    checked.ir.action.minimumRisk !== data.policy.minimumRisk ||
    checked.ir.verification.evaluatorVersion !==
      data.outcome.evaluatorVersion ||
    (data.applicability.trigger.kind === 'exception' &&
      checked.ir.evidence.kind !== data.applicability.trigger.issueType)
  )
    throw new Error('Workflow contracts do not match its steps');
  const contract: WorkflowSource = {
    ...data,
    inputs: checked.ir.inputs,
    context: checked.ir.evidence,
    steps: [
      checked.ir.eligibility,
      checked.ir.action,
      checked.ir.approval,
      checked.ir.verification,
      checked.ir.recovery,
    ],
    provenance: checked.provenance,
  };
  const digest = playbookHash(contract);
  if (supplied !== undefined && supplied !== digest)
    throw new Error('Workflow digest mismatch');

  return { ...contract, digest, format: 'workflow/1' };
}

/** Prints a JSON-literal TypeScript module; the result contains no executable step code. */
export function printWorkflowCode(version: WorkflowVersion): string {
  const checked = compileWorkflow(version);
  const contract = Object.fromEntries(
    Object.entries(checked).filter(
      ([key]) => key !== 'digest' && key !== 'format',
    ),
  );

  return `export default defineWorkflow(${JSON.stringify(contract, null, 2)});\n`;
}

/** Reads only the generated literal format and rejects imports, expressions and code steps. */
export function parseWorkflowCode(code: string): WorkflowVersion {
  const prefix = 'export default defineWorkflow(';
  if (!code.startsWith(prefix) || !code.endsWith(');\n'))
    throw new Error('Unsupported workflow source');

  return compileWorkflow(JSON.parse(code.slice(prefix.length, -3)));
}
