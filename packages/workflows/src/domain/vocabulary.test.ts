import { describe, expect, it } from 'vitest';

import type { WorkflowDraftContent } from './draft.js';
import {
  checkVocabulary,
  mergeVocabulary,
  stepScopes,
  type VocabularyContribution,
} from './vocabulary.js';

const procurement: VocabularyContribution = {
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
      fields: { available: 'number', fresh: 'boolean' },
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
      approval: 'Policy decides.',
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

const computation: VocabularyContribution = {
  triggers: [{ kind: 'manual', executable: true }],
  stepKinds: (['code', 'condition', 'end'] as const).map((kind) => ({
    kind,
    executable: true,
  })),
  codeSteps: { executable: true, reason: null, evaluation: true },
};

const limits = {
  fuel: 100_000_000,
  memoryBytes: 67_108_864,
  wallTimeMs: 5000,
  maxRequests: 0,
};

const vocabulary = mergeVocabulary([procurement, computation], {
  runtime: 'runtime',
  limits,
});

const content: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: { id: 'custom', name: 'Custom', intent: 'Order', category: 'x' },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'manual' },
    subjectKind: 'inventory_position',
  },
  inputs: { target: 'number' },
  context: { kind: 'manual', fields: { low: 'boolean' }, maxAgeSeconds: 300 },
  steps: [
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
        quantity: { source: 'step', stepId: 'stock', field: 'available' },
      },
      expectedPostcondition: {
        status: { source: 'literal', value: 'draft' },
      },
    },
    {
      id: 'check',
      kind: 'verification',
      forStep: 'order',
      evaluatorVersion: 'procurement/1',
      maxDurationSeconds: 60,
      fields: { status: 'string' },
    },
    { id: 'done', kind: 'end', outcome: 'Ordered' },
  ],
};

describe('authoring vocabulary', () => {
  it('keeps unsupported entries visible with the reason they cannot run', () => {
    expect(vocabulary.triggers.find((item) => item.kind === 'manual')).toEqual(
      expect.objectContaining({ executable: true, reason: null }),
    );
    expect(
      vocabulary.triggers.find((item) => item.kind === 'schedule'),
    ).toEqual(
      expect.objectContaining({
        executable: false,
        reason: expect.stringContaining('No installed adapter'),
      }),
    );
    expect(vocabulary.capabilities[0]).toEqual(
      expect.objectContaining({ executable: false, reason: 'Built-in only.' }),
    );
    expect(vocabulary.stepKinds).toHaveLength(9);
    expect(vocabulary.codeSteps).toEqual(
      expect.objectContaining({ executable: true, evaluation: true, limits }),
    );
  });

  it('accepts known entries and warns that they cannot run here', () => {
    const found = checkVocabulary(content, vocabulary);
    expect(found.every((item) => item.severity === 'warning')).toBe(true);
    expect(found.map((item) => item.stepId)).toEqual([
      'stock',
      'order',
      'check',
    ]);
  });

  it('rejects unknown entries, lower risk and mismatched value types on the offending field', () => {
    const found = checkVocabulary(
      {
        ...content,
        applicability: { ...content.applicability, subjectKind: 'invoice' },
        steps: [
          {
            ...content.steps[0]!,
            fields: { available: 'string' },
          } as WorkflowDraftContent['steps'][number],
          {
            ...(content.steps[1] as Extract<
              WorkflowDraftContent['steps'][number],
              { kind: 'capability' }
            >),
            minimumRisk: 'low',
            parameters: {
              quantity: { source: 'literal', value: 'ten' },
            },
          },
          {
            ...(content.steps[2] as Extract<
              WorkflowDraftContent['steps'][number],
              { kind: 'verification' }
            >),
            evaluatorVersion: 'unknown/1',
          },
          content.steps[3]!,
        ],
      },
      vocabulary,
    );
    const errors = found.filter((item) => item.severity === 'error');
    expect(errors.map((item) => [item.code, item.stepId, item.field])).toEqual([
      ['unknown_subject', null, 'applicability.subjectKind'],
      ['field_type_mismatch', 'stock', 'fields.available'],
      ['risk_below_floor', 'order', 'minimumRisk'],
      ['value_type_mismatch', 'order', 'parameters.quantity'],
      ['unknown_evaluator', 'check', 'evaluatorVersion'],
    ]);
  });

  it('offers only inputs, evidence and outputs of earlier steps', () => {
    const scopes = stepScopes(content);
    expect(scopes[0]!.map((item) => item.field)).toEqual(['target', 'low']);
    expect(scopes[1]).toContainEqual({
      source: 'step',
      stepId: 'stock',
      field: 'available',
      type: 'number',
    });
    expect(scopes[0]!.some((item) => item.source === 'step')).toBe(false);
  });
});
