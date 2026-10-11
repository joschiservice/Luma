import { describe, expect, it } from 'vitest';

import type { Approval, ProposedAction } from './action.js';
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
              { available: true, minimumRisk, permission: 'actions.execute' },
              new Set(['actions.execute']),
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

describe('evaluatePolicy', () => {
  it('denies actors without the permission the capability needs', () => {
    const evaluate = (granted: string[], permission: string) =>
      evaluatePolicy(
        action('low'),
        { available: true, minimumRisk: 'low', permission },
        new Set(granted),
        'owner',
        now,
      );
    expect(evaluate([], 'actions.execute')).toEqual({
      outcome: 'denied',
      reason: 'permission_denied',
    });
    expect(evaluate(['actions.execute'], 'jtl:purchase_orders.submit')).toEqual(
      { outcome: 'denied', reason: 'permission_denied' },
    );
    expect(
      evaluate(['jtl:purchase_orders.submit'], 'jtl:purchase_orders.submit'),
    ).toEqual({ outcome: 'allowed', reason: 'authorized' });
  });
});

it('requires a review and accepts self-approval only when the independent rule is off', () => {
  const capability = {
    available: true,
    minimumRisk: 'high' as const,
    permission: 'actions.execute',
  };
  const access = new Set(['actions.execute']);
  const approval: Approval = {
    id: 'approval',
    decisionId: 'decision',
    correlationId: 'request',
    tenantId: 'tenant',
    proposalId: 'proposal',
    actionHash: 'hash',
    policyVersion: 'version',
    requesterId: 'owner',
    approverId: 'owner',
    outcome: 'approved',
    createdAt: '2026-10-03T08:00:00.000Z',
    expiresAt: '2026-10-03T08:05:00.000Z',
  };
  expect(
    evaluatePolicy(
      action('high'),
      capability,
      access,
      'owner',
      now,
      null,
      false,
      false,
    ).outcome,
  ).toBe('approval_required');
  expect(
    evaluatePolicy(action('high'), capability, access, 'owner', now, approval)
      .outcome,
  ).toBe('approval_required');
  expect(
    evaluatePolicy(
      action('high'),
      capability,
      access,
      'owner',
      now,
      approval,
      false,
      false,
    ).outcome,
  ).toBe('allowed');
  expect(
    evaluatePolicy(
      action('high'),
      capability,
      new Set(),
      'owner',
      now,
      approval,
      false,
      false,
    ).reason,
  ).toBe('permission_denied');
  expect(
    evaluatePolicy(
      action('high'),
      capability,
      access,
      'owner',
      now,
      { ...approval, outcome: 'rejected' },
      false,
      false,
    ).reason,
  ).toBe('approval_rejected');
});
