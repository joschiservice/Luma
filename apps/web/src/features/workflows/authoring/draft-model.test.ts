import type {
  AuthoringVocabulary,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  createSteps,
  defaultInsertIndex,
  duplicateStep,
  insertSteps,
  moveStep,
  paletteItems,
  removeStep,
  renameStep,
  stepFacts,
  uniqueStepId,
  valueLabel,
} from './draft-model';

const vocabulary: AuthoringVocabulary = {
  triggers: [],
  stepKinds: [],
  subjects: [],
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
  codeSteps: {
    executable: true,
    reason: null,
    evaluation: true,
    runtime: 'runtime',
    limits: { fuel: 1, memoryBytes: 1, wallTimeMs: 1, maxRequests: 0 },
  },
};

const content: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: { id: 'custom', name: 'Custom', intent: '', category: 'custom' },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  inputs: {},
  context: { kind: 'manual', fields: {}, maxAgeSeconds: 300 },
  steps: [{ id: 'finish', kind: 'end', outcome: 'Done' }],
};

describe('draft model', () => {
  it('adds an action together with the check that must follow it', () => {
    const steps = createSteps('capability', content, vocabulary);
    expect(steps.map((step) => [step.kind, step.id])).toEqual([
      ['capability', 'action'],
      ['verification', 'verify-action'],
    ]);
    expect(steps[1]).toEqual(
      expect.objectContaining({
        forStep: 'action',
        evaluatorVersion: 'procurement/1',
        fields: { status: 'string' },
      }),
    );
  });

  it('links a new approval to the action after it', () => {
    const withAction = insertSteps(
      content,
      0,
      createSteps('capability', content, vocabulary),
    );
    const approved = insertSteps(
      withAction,
      0,
      createSteps('approval', withAction, vocabulary),
    );
    expect(approved.steps[0]).toEqual(
      expect.objectContaining({ kind: 'approval', forStep: 'action' }),
    );
  });

  it('moves, removes and keeps IDs unique', () => {
    const steps = insertSteps(content, 0, [
      ...createSteps('read', content, vocabulary),
    ]);
    expect(moveStep(steps, 0, 1).steps.map((step) => step.id)).toEqual([
      'finish',
      'read',
    ]);
    expect(moveStep(steps, 0, 5)).toBe(steps);
    expect(removeStep(steps, 0).steps.map((step) => step.id)).toEqual([
      'finish',
    ]);
    expect(uniqueStepId(steps, 'read')).toBe('read-2');
    expect(uniqueStepId(steps, '9 Odd Name!')).toBe('odd-name-');
  });

  it('renames a step and every reference to it', () => {
    const withAction = insertSteps(content, 0, [
      ...createSteps('read', content, vocabulary),
      ...createSteps('capability', content, vocabulary),
    ]);
    const referenced = {
      ...withAction,
      steps: withAction.steps.map((step) =>
        step.kind === 'capability'
          ? {
              ...step,
              parameters: {
                quantity: {
                  source: 'step' as const,
                  stepId: 'read',
                  field: 'available',
                },
              },
            }
          : step,
      ),
    };
    const renamed = renameStep(referenced, 'read', 'stock');
    expect(renamed.steps[0]!.id).toBe('stock');
    expect(renamed.steps[1]).toEqual(
      expect.objectContaining({
        parameters: {
          quantity: { source: 'step', stepId: 'stock', field: 'available' },
        },
      }),
    );
    expect(renameStep(renamed, 'action', 'order').steps[2]).toEqual(
      expect.objectContaining({ forStep: 'order' }),
    );
  });

  it('describes value sources in plain words', () => {
    expect(valueLabel({ source: 'input', field: 'targetStock' })).toBe(
      'Input: target stock',
    );
    expect(
      valueLabel({ source: 'step', stepId: 'proposal', field: 'quantity' }),
    ).toBe('proposal → quantity');
  });
});

describe('builder palette and scanning', () => {
  it('lists installed sources and actions as ready-made steps', () => {
    const items = paletteItems({
      ...vocabulary,
      stepKinds: (['read', 'capability', 'wait'] as const).map((kind) => ({
        kind,
        label: kind,
        description: '',
        executable: true,
        reason: null,
      })),
    });
    expect(items.map((item) => [item.key, item.group])).toEqual([
      ['read:inventory', 'data'],
      ['capability:procurement.purchase-order.create@1', 'act'],
      ['wait', 'decide'],
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({ executable: false, reason: 'Built-in only.' }),
    );
  });

  it('inserts before the final step and duplicates with a new ID', () => {
    expect(defaultInsertIndex(content)).toBe(0);
    expect(defaultInsertIndex({ ...content, steps: [] })).toBe(0);
    const copy = duplicateStep(content, 0);
    expect(copy.steps.map((step) => step.id)).toEqual([
      'finish',
      'finish-copy',
    ]);
  });

  it('summarizes steps for scanning', () => {
    const withAction = insertSteps(content, 0, [
      { id: 'ok', kind: 'approval', forStep: '', expiresAfterSeconds: 3600 },
      ...createSteps('capability', content, vocabulary),
    ]);
    expect(stepFacts(withAction, 0)).toEqual(['Decide within 1 hour']);
    expect(stepFacts(withAction, 1)).toEqual([
      'Medium risk',
      'Asks a person first',
    ]);
  });
});
