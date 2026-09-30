import { describe, expect, it } from 'vitest';

import {
  caseDeadline,
  type CaseDecisionFacts,
  caseDomain,
  evidenceState,
  presentCase,
  presentReplenishment,
  type ReplenishmentProposal,
} from './decisions.js';

const asOf = '2026-09-30T09:00:00.000Z';
const owner = { id: 'reviewer', role: 'owner' as const };

const facts = (overrides: Partial<CaseDecisionFacts>): CaseDecisionFacts => ({
  exception_id: '6f1c7a52-0f6d-4d0e-9f0b-3a4a5e0f1a2b',
  reason: 'approval',
  requested_at: '2026-09-30T08:50:00.000Z',
  severity: 'high',
  class: 'workflow_failure',
  state: 'awaiting_approval',
  subject: { subjectKind: 'order', subjectId: '10', scope: ['connection'] },
  diagnosis_status: 'ready',
  summary: 'The order uses an unmapped shipping method.',
  valid_until: '2026-09-30T09:20:00.000Z',
  observed_at: '2026-09-30T08:45:00.000Z',
  manual_step: null,
  exposed_quantity: null,
  exposed_unit: null,
  requester_id: 'requester',
  decision_id: 'decision',
  proposal: {
    capability: 'orders.shipping-method.write',
    target: { kind: 'order', id: '10' },
    parameters: {},
    expectedPostcondition: { shippingMethodId: '8' },
    risk: 'high',
    expiresAt: '2026-09-30T09:15:00.000Z',
    preconditions: { validUntil: '2026-09-30T09:10:00.000Z' },
  },
  ...overrides,
});

describe('case decisions', () => {
  it('binds approvals to the earliest expiry of proposal, preconditions and evidence', () => {
    expect(caseDeadline(facts({}))).toBe('2026-09-30T09:10:00.000Z');
    expect(caseDeadline(facts({ reason: 'manual_intervention' }))).toBeNull();
    expect(caseDeadline(facts({ proposal: null }))).toBeNull();
  });

  it('lets only a different owner or admin decide an approval', () => {
    expect(presentCase(facts({}), owner, asOf).response).toBe('decide');
    expect(
      presentCase(facts({}), { id: 'requester', role: 'admin' }, asOf).response,
    ).toBe('awaiting_other');
    expect(
      presentCase(facts({}), { id: 'member', role: 'member' }, asOf).response,
    ).toBe('view_only');
    const expired = presentCase(facts({ proposal: null }), owner, asOf);
    expect(expired.response).toBe('investigate');
    expect(expired.consequences.map((c) => c.response)).toEqual(['Escalate']);
  });

  it('explains the approval, its exact change and each response', () => {
    const item = presentCase(facts({}), owner, asOf);
    expect(item).toMatchObject({
      id: 'case:6f1c7a52-0f6d-4d0e-9f0b-3a4a5e0f1a2b',
      title: 'Approve shipping method correction',
      domain: 'orders',
      impact: { level: 'high', text: null },
      owner: { kind: 'case' },
      group: { key: 'case:workflow_failure:approval' },
    });
    expect(item.consequences.map((c) => c.response)).toEqual([
      'Approve',
      'Reject',
      'Escalate',
    ]);
    expect(item.change).toContainEqual({
      label: 'Expected shipping method id',
      value: '8',
    });
  });

  it('withholds stale findings and manual steps', () => {
    const stale = facts({
      reason: 'manual_intervention',
      valid_until: '2026-09-30T08:59:00.000Z',
      manual_step: 'Correct the stock in JTL.',
    });
    const item = presentCase(stale, owner, asOf);
    expect(item.subject.detail).toBeNull();
    expect(item.why).not.toContain('JTL');
    const current = presentCase(
      { ...stale, valid_until: '2026-09-30T09:30:00.000Z' },
      owner,
      asOf,
    );
    expect(current.why).toBe('Correct the stock in JTL.');
    expect(current.response).toBe('investigate');
  });

  it('labels impact honestly and maps subjects to operational areas', () => {
    expect(
      presentCase(facts({ severity: null }), owner, asOf).impact.level,
    ).toBe('unknown');
    expect(caseDomain('sku', 'inventory_mismatch')).toBe('inventory');
    expect(caseDomain('fulfillment', 'stuck_fulfillment')).toBe('fulfillment');
    expect(caseDomain('connection', 'sync_failure')).toBe('operations');
  });
});

describe('replenishment decisions', () => {
  const proposal: ReplenishmentProposal = {
    runId: '0b8c4e0a-5f7a-4d53-a2b5-5c6d7e8f9a0b',
    definitionId: 'inventory-replenishment',
    positionId: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f',
    sku: 'LAMP-01',
    supplier: 'Northstar Supply',
    quantity: 50,
    unit: 'each',
    available: 4,
    minimum: 14,
    target: 54,
    approvalQuantity: 20,
    reference: 'REP-0B8C4E0A',
    checkedAt: '2026-09-30T08:58:00.000Z',
    requestedAt: '2026-09-30T08:58:05.000Z',
    requesterId: 'principal',
    expiresAt: '2026-09-30T09:03:00.000Z',
    risk: 'high',
    canRespond: true,
  };

  it('presents the draft, stock evidence and deadline for approval', () => {
    const item = presentReplenishment(proposal, 'reviewer');
    expect(item).toMatchObject({
      id: `replenishment:${proposal.runId}`,
      reason: 'approval',
      domain: 'procurement',
      response: 'decide',
      deadline: proposal.expiresAt,
      impact: { level: 'high' },
      record: { kind: 'position', id: proposal.positionId },
      owner: { kind: 'workflow_run', runId: proposal.runId },
    });
    expect(item.why).toContain('20-unit limit');
    expect(item.change).toContainEqual({ label: 'Quantity', value: '50 each' });
    expect(item.consequences[0]!.text).toContain('Nothing is sent');
  });

  it('tells the principal a different approver is needed', () => {
    expect(
      presentReplenishment(
        { ...proposal, canRespond: false, risk: 'medium' },
        'principal',
      ),
    ).toMatchObject({
      response: 'awaiting_other',
      impact: { level: 'medium' },
    });
  });
});

it('treats evidence without a validity as unknown', () => {
  expect(evidenceState(null, asOf)).toBe('unknown');
  expect(evidenceState('2026-09-30T09:00:01.000Z', asOf)).toBe('fresh');
  expect(evidenceState(asOf, asOf)).toBe('stale');
});
