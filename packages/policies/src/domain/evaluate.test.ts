import { describe, expect, it } from 'vitest';

import type { ProposedAction } from './action.js';
import { approvalRequirement, evaluatePolicy } from './evaluate.js';

const risks = ['low', 'medium', 'high'] as const;
const now = Date.parse('2026-10-03T08:00:00.000Z');
const action = (risk: ProposedAction['risk']): ProposedAction => ({
  schemaVersion: 1,
  id: 'proposal',
  tenantId: 'tenant',
  capability: 'procurement.purchase-order.create',
  capabilityVersion: '1',
  connectionId: 'connection',
  target: { kind: 'purchase_order', id: 'order' },
  parameters: {},
  preconditions: { evidenceRefs: [], validUntil: '2026-10-03T08:05:00.000Z' },
  expectedPostcondition: {},
  risk,
  proposedBy: { kind: 'user', id: 'owner' },
  expiresAt: '2026-10-03T08:05:00.000Z',
});

describe('approvalRequirement', () => {
  it('agrees with admission for every risk and workspace setting', () => {
    for (const minimumRisk of risks)
      for (const workspaceRequired of [false, true]) {
        const requirement = approvalRequirement({
          minimumRisk,
          workspaceRequired,
        });
        const outcomes = risks.map(
          (risk) =>
            evaluatePolicy(
              action(risk),
              { available: true, minimumRisk },
              'owner',
              'owner',
              now,
              null,
              workspaceRequired,
            ).outcome,
        );
        if (requirement.mode === 'every_action')
          expect(outcomes).toEqual(risks.map(() => 'approval_required'));
        else expect(outcomes[0]).toBe('allowed');
      }
  });

  it('never lets a quantity-based risk below the capability minimum remove approval', () => {
    expect(
      approvalRequirement({ minimumRisk: 'medium', workspaceRequired: false }),
    ).toEqual({ mode: 'every_action', reason: 'minimum_risk' });
    expect(
      approvalRequirement({ minimumRisk: 'low', workspaceRequired: true }),
    ).toEqual({ mode: 'every_action', reason: 'workspace_policy' });
    expect(
      approvalRequirement({
        minimumRisk: 'low',
        workspaceRequired: false,
        workflowRequired: true,
      }),
    ).toEqual({ mode: 'every_action', reason: 'workflow' });
  });
});
