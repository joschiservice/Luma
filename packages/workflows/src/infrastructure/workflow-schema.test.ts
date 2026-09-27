import { describe, expect, it } from 'vitest';

import { shippingMethodPlaybook } from '../domain/shipping-method.fixture.js';
import { resolutionWorkflow } from '../domain/workflow.js';
import { compilePlaybook } from './playbooks/schema.js';
import {
  compileWorkflow,
  defineWorkflow,
  parseWorkflowCode,
  printWorkflowCode,
} from './workflow-schema.js';

const legacy = compilePlaybook(shippingMethodPlaybook);

function source() {
  const projected = resolutionWorkflow(legacy);

  return {
    schemaVersion: projected.schemaVersion,
    definition: projected.definition,
    version: projected.version,
    applicability: projected.applicability,
    inputs: projected.inputs,
    context: projected.context,
    steps: projected.steps,
    policy: projected.policy,
    outcome: projected.outcome,
    provenance: projected.provenance,
  };
}

describe('Workflow authoring and compatibility', () => {
  it('preserves legacy identity, digest and all stable step IDs', () => {
    const workflow = resolutionWorkflow(legacy);
    expect(workflow.definition.id).toBe(legacy.definition.id);
    expect(workflow.digest).toBe(legacy.digest);
    expect(workflow.steps.map((s) => s.id)).toEqual([
      legacy.ir.eligibility.id,
      legacy.ir.action.id,
      legacy.ir.approval.id,
      legacy.ir.verification.id,
      legacy.ir.recovery.id,
    ]);
    expect(workflow.outcome).toMatchObject({
      evaluatorVersion: 'shipping-method/1',
      onUnverified: 'escalate',
    });
  });
  it('authors an immutable workflow without an Exception root', () => {
    const input = source();
    const workflow = defineWorkflow({
      ...input,
      definition: { ...input.definition, category: 'operations' },
      applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
    });
    expect(workflow.applicability.trigger).toEqual({ kind: 'manual' });
    expect(compileWorkflow(workflow)).toEqual(workflow);
    expect(parseWorkflowCode(printWorkflowCode(workflow))).toEqual(workflow);
  });
  it('binds changes to triggers, category, context and outcomes into the digest', () => {
    const input = source();
    const workflow = defineWorkflow(input);
    const changed = defineWorkflow({
      ...input,
      applicability: {
        ...input.applicability,
        trigger: { kind: 'event', eventType: 'order.updated' },
      },
    });
    expect(changed.digest).not.toBe(workflow.digest);
    expect(() =>
      compileWorkflow({ ...changed, digest: workflow.digest }),
    ).toThrow('digest mismatch');
    expect(() =>
      defineWorkflow({
        ...input,
        policy: { ...input.policy, approval: 'policy' },
      }),
    ).toThrow('contracts do not match');
  });
  it('rejects code execution, duplicate steps and inconsistent subject contracts', () => {
    const input = source();
    expect(() =>
      compileWorkflow({
        ...input,
        steps: [
          { id: 'code', kind: 'typescript', source: 'process.exit()' },
          ...input.steps.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      compileWorkflow({
        ...input,
        steps: input.steps.map((s) => ({ ...s, id: 'same' })),
      }),
    ).toThrow();
    expect(() =>
      defineWorkflow({
        ...input,
        applicability: { ...input.applicability, subjectKind: 'supplier' },
      }),
    ).toThrow();
    expect(() =>
      parseWorkflowCode('export default defineWorkflow(process.env);\n'),
    ).toThrow();
    expect(() =>
      compileWorkflow({ ...input, agent: { id: 'untrusted' } }),
    ).toThrow();
  });
  it('versions schedule times and checks condition field types', () => {
    const input = source();
    const schedule = defineWorkflow({
      ...input,
      applicability: {
        subjectKind: 'order',
        trigger: { kind: 'schedule', at: '2026-10-01T00:00:00Z' },
      },
    });
    expect(compileWorkflow(schedule)).toEqual(schedule);
    expect(
      defineWorkflow({
        ...input,
        applicability: {
          subjectKind: 'order',
          trigger: { kind: 'schedule', at: '2026-10-02T00:00:00Z' },
        },
      }).digest,
    ).not.toBe(schedule.digest);
    expect(() =>
      defineWorkflow({
        ...input,
        applicability: {
          subjectKind: 'order',
          trigger: {
            kind: 'condition',
            field: 'diagnosisReady',
            equals: 'yes',
          },
        },
      }),
    ).toThrow('declared context field');
  });
});
