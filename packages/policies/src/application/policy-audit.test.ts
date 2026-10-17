import { describe, expect, it, vi } from 'vitest';

import type { Approval, PolicyDecision } from '../domain/action.js';
import { policyAudit } from './policy-audit.js';

const decision: PolicyDecision = {
  correlationId: 'correlation',
  id: 'decision',
  tenantId: 'tenant',
  proposalId: 'proposal',
  actionHash: 'hash',
  actorId: 'requester',
  capability: 'orders.edit',
  policyVersion: 'v0.1',
  outcome: 'approval_required',
  reason: 'approval_required',
  evaluatedAt: '2026-10-14T05:00:00Z',
  validUntil: '2026-10-14T06:00:00Z',
};

const approval: Approval = {
  decisionId: 'decision',
  correlationId: 'correlation',
  id: 'approval',
  tenantId: 'tenant',
  proposalId: 'proposal',
  actionHash: 'hash',
  policyVersion: 'v0.1',
  requesterId: 'requester',
  approverId: 'approver',
  outcome: 'approved',
  expiresAt: '2026-10-14T06:00:00Z',
  createdAt: '2026-10-14T05:10:00Z',
};

describe('policyAudit', () => {
  it('records the decision actor and reason', async () => {
    const append = vi.fn(async () => {});

    await policyAudit({ append })({
      type: 'policy.evaluated',
      document: decision,
    });

    expect(append).toHaveBeenCalledWith({
      id: 'decision',
      tenantId: 'tenant',
      eventKey: 'decision',
      eventType: 'policy.evaluated',
      schemaVersion: 1,
      occurredAt: '2026-10-14T05:00:00Z',
      actor: { kind: 'user', id: 'requester' },
      correlationId: 'correlation',
      proposalId: 'proposal',
      actionHash: 'hash',
      policyDecisionId: 'decision',
      evidenceRefs: [],
      details: {
        outcome: 'approval_required',
        policyVersion: 'v0.1',
        reason: 'approval_required',
      },
    });
  });

  it('records the approver, requester and approval expiry', async () => {
    const append = vi.fn(async () => {});

    await policyAudit({ append })({
      type: 'approval.responded',
      document: approval,
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'approval',
        eventType: 'approval.responded',
        occurredAt: '2026-10-14T05:10:00Z',
        actor: { kind: 'user', id: 'approver' },
        policyDecisionId: 'decision',
        details: {
          outcome: 'approved',
          policyVersion: 'v0.1',
          requesterId: 'requester',
          expiresAt: '2026-10-14T06:00:00Z',
        },
      }),
    );
  });

  it('propagates audit failures', async () => {
    const append = vi.fn(async () => {
      throw new Error('audit unavailable');
    });

    await expect(
      policyAudit({ append })({ type: 'policy.evaluated', document: decision }),
    ).rejects.toThrow('audit unavailable');
  });
});
