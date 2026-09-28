import { describe, expect, it } from 'vitest';

import type { WorkflowDraftContent } from './draft.js';
import { diffDraft } from './draft-diff.js';
import {
  checkCodeStepOutput,
  codeStepPosition,
  withInstalledVocabulary,
} from './draft-generation.js';
import { draftOutputSchema } from './generation-schema.js';
import { mergeVocabulary, type VocabularyContribution } from './vocabulary.js';

const limits = {
  fuel: 100_000_000,
  memoryBytes: 67_108_864,
  wallTimeMs: 5000,
  maxRequests: 0,
};

const installed: VocabularyContribution = {
  subjects: [
    {
      kind: 'inventory_position',
      label: 'Stock position',
      description: '',
      executable: false,
      reason: 'Built-in only.',
    },
  ],
  reads: [
    {
      source: 'inventory',
      label: 'Current stock',
      description: '',
      fields: { available: 'number' },
      executable: false,
      reason: 'Built-in only.',
    },
  ],
  capabilities: [
    {
      capability: 'procurement.purchase-order.create',
      version: '1',
      label: 'Create a purchase-order draft',
      description: '',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      approval: '',
      parameters: { quantity: 'number' },
      postcondition: { status: 'string' },
      evaluators: ['procurement/1'],
      executable: false,
      reason: 'Built-in only.',
    },
  ],
  evaluators: [
    {
      version: 'procurement/1',
      label: 'Check the draft',
      description: '',
      fields: { status: 'string' },
      executable: false,
      reason: 'Built-in only.',
    },
  ],
};

const vocabulary = mergeVocabulary([installed], { runtime: 'runtime', limits });

const content: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: { id: 'reorder', name: 'Reorder', intent: 'x', category: 'x' },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'manual' },
    subjectKind: 'inventory_position',
  },
  inputs: { target: 'number' },
  context: { kind: 'manual', fields: {}, maxAgeSeconds: 300 },
  steps: [
    {
      id: 'calc',
      kind: 'code',
      source: '',
      fields: { quantity: 'number' },
      grants: [],
      limits,
    },
    {
      id: 'stock',
      kind: 'read',
      source: 'inventory',
      fields: { available: 'number' },
    },
    {
      id: 'order',
      kind: 'capability',
      capability: 'procurement.purchase-order.create',
      capabilityVersion: '1',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      parameters: {
        quantity: { source: 'step', stepId: 'calc', field: 'quantity' },
      },
      expectedPostcondition: { status: { source: 'literal', value: 'draft' } },
    },
    {
      id: 'check',
      kind: 'verification',
      forStep: 'order',
      evaluatorVersion: 'procurement/1',
      maxDurationSeconds: 60,
      fields: { status: 'string' },
    },
    { id: 'wait', kind: 'wait', seconds: 5 },
    { id: 'done', kind: 'end', outcome: 'Done' },
  ],
};

describe('draft generation rules', () => {
  it('offers only installed entries and no Code Steps when the workspace has none', () => {
    const schema = JSON.stringify(draftOutputSchema(vocabulary));
    expect(schema).toContain('"enum":["procurement.purchase-order.create"]');
    expect(schema).toContain('"enum":["medium","high"]');
    expect(schema).toContain('"enum":["inventory_position"]');
    expect(schema).not.toContain('"enum":["code"]');
    expect(
      JSON.stringify(
        draftOutputSchema({
          ...vocabulary,
          codeSteps: { ...vocabulary.codeSteps, evaluation: true },
        }),
      ),
    ).toContain('"enum":["code"]');
  });

  it('clears uninstalled entries and drops undeclared fields and values', () => {
    const { content: cleaned, questions } = withInstalledVocabulary(
      {
        ...content,
        applicability: { ...content.applicability, subjectKind: 'invoice' },
        steps: content.steps.map((step) =>
          step.kind === 'read'
            ? { ...step, fields: { available: 'number', secret: 'string' } }
            : step.kind === 'capability'
              ? {
                  ...step,
                  parameters: {
                    ...step.parameters,
                    supplier: { source: 'literal', value: 'ACME' },
                  },
                }
              : step.kind === 'verification'
                ? { ...step, evaluatorVersion: 'refunds/1' }
                : step,
        ),
      },
      vocabulary,
    );
    expect(cleaned.applicability.subjectKind).toBe('');
    expect(cleaned.steps.map((step) => step.kind)).not.toContain('code');
    expect(cleaned.steps.find((step) => step.id === 'stock')).toMatchObject({
      fields: { available: 'number' },
    });
    expect(
      Object.keys(
        (
          cleaned.steps.find((step) => step.id === 'order') as {
            parameters: object;
          }
        ).parameters,
      ),
    ).toEqual(['quantity']);
    expect(cleaned.steps.find((step) => step.id === 'check')).toMatchObject({
      evaluatorVersion: '',
      fields: {},
    });
    expect(questions.map((item) => [item.stepId, item.field])).toEqual([
      [null, 'applicability.subjectKind'],
      [null, 'steps'],
      ['check', 'evaluatorVersion'],
    ]);
  });

  it('describes removed steps and workflow-level changes', () => {
    const changes = diffDraft(
      content,
      {
        ...content,
        applicability: {
          trigger: { kind: 'condition', field: 'low', equals: true },
          subjectKind: 'inventory_position',
        },
        inputs: {},
        steps: content.steps.filter((step) => step.id !== 'wait'),
      },
      vocabulary,
    );
    expect(
      changes.map((item) => [item.change, item.stepId ?? item.field]),
    ).toEqual([
      ['changed', 'applicability.trigger'],
      ['changed', 'inputs'],
      ['removed', 'wait'],
    ]);
    expect(changes[1]!.summary).toBe('Inputs: removes target.');
    expect(changes[2]).toMatchObject({
      before: { id: 'wait' },
      after: null,
      summary: 'Removes “wait”: Wait 5 second(s).',
    });
  });

  it('lets a Code Step request only the reads and actions directly after it', () => {
    const position = codeStepPosition(content, 'calc')!;
    expect(position.grantable.map((step) => step.id)).toEqual([
      'stock',
      'order',
    ]);
    expect(codeStepPosition(content, 'stock')).toBeNull();
    expect(codeStepPosition(content, null)!.grantable).toEqual([]);

    const problems = checkCodeStepOutput(
      {
        source: 'function main() { return { quantity: 1 }; }',
        fields: { quantity: 'number' },
        grants: ['order'],
        explanation: '',
        examples: [
          {
            name: 'Too much',
            input: {
              inputs: { target: '5' },
              evidence: {},
              steps: { stock: { available: 1 } },
            },
            replies: { stock: {} },
            expected: { quantity: 'one' },
          },
        ],
      },
      position,
    );
    expect(problems.map((item) => [item.code, item.field])).toEqual([
      ['code_grants', 'grants'],
      ['code_example_value', 'examples.0.input.inputs.target'],
      ['code_example_value', 'examples.0.input.steps.stock.available'],
      ['code_example_reply', 'examples.0.replies.stock'],
      ['code_example_expected', 'examples.0.expected.quantity'],
    ]);
  });
});
