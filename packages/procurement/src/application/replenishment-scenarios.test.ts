import type {
  ProcessWorkflowVersion,
  WorkflowDraftContent,
} from '@luma/workflows';
import { describe, expect, it } from 'vitest';

import { replenishmentSource } from '../domain/replenishment.js';
import { createReplenishmentScenarios } from './replenishment-scenarios.js';

const content = Object.fromEntries(
  Object.entries(replenishmentSource).filter(([key]) => key !== 'provenance'),
) as unknown as WorkflowDraftContent;
const version = {
  ...replenishmentSource,
  format: 'workflow/2',
  digest: 'a'.repeat(64),
} as ProcessWorkflowVersion;
const scenarios = createReplenishmentScenarios(version);

describe('replenishment test scenarios', () => {
  it('offers the six simulator scenarios with their expected outcomes', () => {
    const offered = scenarios.scenarios(content);
    expect(offered.map((item) => [item.id, item.case.expected])).toEqual([
      ['approval-pending', { outcome: 'awaiting_decision' }],
      ['approved-verified', { outcome: 'verified' }],
      ['policy-rejected', { outcome: 'escalated' }],
      ['stale-inventory', { outcome: 'escalated' }],
      ['existing-order', { outcome: 'ended' }],
      ['verification-failed', { outcome: 'failed_verification' }],
    ]);
    const stale = offered.find((item) => item.id === 'stale-inventory')!.case;
    expect(stale).toMatchObject({
      name: 'Stale stock',
      inputs: { activationId: 'example-rule' },
      evidence: { belowMinimum: true },
      replies: {
        inventory: {
          kind: 'read',
          values: { fresh: false, available: 10, sku: 'SKU-100', unit: 'pcs' },
        },
        'create-order': { kind: 'capability', result: 'accepted' },
      },
    });
  });

  it('maps scenarios onto customized copies by read source, action and result check', () => {
    const rename: Record<string, string> = {
      inventory: 'stock-now',
      proposal: 'plan',
      'create-order': 'po',
      'verify-order': 'po-check',
    };
    const copy = {
      ...content,
      definition: { ...content.definition, id: 'my-restock' },
      inputs: {},
      steps: content.steps.map((step) => ({
        ...step,
        id: rename[step.id] ?? step.id,
        ...('forStep' in step ? { forStep: rename[step.forStep] } : {}),
        ...(step.kind === 'read' && step.id === 'proposal'
          ? { fields: { eligible: 'boolean', quantity: 'number' } }
          : {}),
      })),
    } as WorkflowDraftContent;
    const failed = scenarios
      .scenarios(copy)
      .find((item) => item.id === 'verification-failed')!.case;
    expect(failed.inputs).toEqual({});
    expect(failed.replies).toEqual({
      'stock-now': {
        kind: 'read',
        values: { fresh: true, available: 10, sku: 'SKU-100', unit: 'pcs' },
      },
      plan: { kind: 'read', values: { eligible: true, quantity: 50 } },
      po: { kind: 'capability', result: 'accepted' },
      'po-check': {
        kind: 'verification',
        state: 'failed',
        values: {
          purchaseOrderId: 'example-order',
          quantity: 50,
          status: 'unverified',
        },
      },
    });
  });

  it('offers nothing to drafts that use none of the replenishment steps', () => {
    expect(
      scenarios.scenarios({
        ...content,
        steps: [{ id: 'finish', kind: 'end', outcome: 'Done' }],
      }),
    ).toEqual([]);
  });
});
