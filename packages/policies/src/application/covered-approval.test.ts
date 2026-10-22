import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  type Approval,
  type ProposedAction,
  workspacePolicyVersion,
} from '../domain/action.js';
import { createPolicyService } from './policies.js';

const now = new Date('2026-10-14T05:00:00Z');
const context = makeTenantContext(
  { userId: 'requester', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'AU',
  },
  builtInMembership(
    { id: 'membership', organizationId: 'tenant', userId: 'requester' },
    'owner',
  ),
  'request',
);
const action: ProposedAction = {
  schemaVersion: 1,
  id: 'send',
  tenantId: 'tenant',
  capability: 'purchase-orders.submit',
  capabilityVersion: '0',
  connectionId: 'connection',
  target: { kind: 'purchase_order_submission', id: 'submission' },
  parameters: {},
  preconditions: { evidenceRefs: [], validUntil: '2026-10-14T06:00:00Z' },
  expectedPostcondition: {},
  risk: 'high',
  proposedBy: { kind: 'user', id: 'requester' },
  expiresAt: '2026-10-14T06:00:00Z',
};
const grant: Approval = {
  id: 'original-human-approval',
  tenantId: 'tenant',
  proposalId: 'draft',
  actionHash: 'draft-hash',
  correlationId: 'request',
  decisionId: 'draft-decision',
  policyVersion: workspacePolicyVersion(0, true),
  requesterId: 'requester',
  approverId: 'approver',
  outcome: 'approved',
  expiresAt: '2026-10-14T05:01:00Z',
  createdAt: now.toISOString(),
};

async function evaluate(
  covered: Approval | null,
  direct: Approval | null = null,
  available = true,
) {
  const coverage = vi.fn(async () => covered);
  const save = vi.fn(async () => {});
  const service = createPolicyService({
    repository: {
      workspacePolicy: async () => ({
        revision: 0,
        required: true,
        requireIndependentApproval: true,
      }),
      pending: async () => [],
      delivered: async () => {},
      saveDecision: save,
      findDecision: async () => null,
      findDecisions: async () => [],
      findApproval: async () => direct,
      saveApproval: async (value) => value,
    },
    coveredApproval: coverage,
    appendEvidence: async () => {},
    refreshContext: async (value) => value,
    now: () => now,
    id: () => 'new-decision',
  });
  const decision = await service.evaluate(context, action, 'send-hash', {
    available,
    minimumRisk: 'high',
    permission: 'actions.execute',
  });

  return { decision, coverage, save };
}

describe('covered approval admission', () => {
  it('records the original human grant and caps authorization at its expiry', async () => {
    const { decision, save } = await evaluate(grant);
    expect(decision).toMatchObject({
      outcome: 'allowed',
      reason: 'covered_approval',
      approvalId: grant.id,
      proposalId: 'send',
      actionHash: 'send-hash',
    });
    expect(Date.parse(decision.validUntil)).toBeLessThanOrEqual(
      Date.parse(grant.expiresAt),
    );
    expect(save).toHaveBeenCalledOnce();
  });
  it.each([
    { ...grant, tenantId: 'other' },
    { ...grant, policyVersion: 'old' },
    { ...grant, requesterId: 'other' },
    { ...grant, approverId: 'requester' },
    { ...grant, expiresAt: now.toISOString() },
    { ...grant, outcome: 'rejected' as const },
  ])('requires a new response for invalid coverage %j', async (invalid) => {
    expect((await evaluate(invalid)).decision.outcome).toBe(
      'approval_required',
    );
  });
  it('cannot override a direct rejection or capability denial', async () => {
    const rejected = await evaluate(grant, {
      ...grant,
      proposalId: 'send',
      actionHash: 'send-hash',
      outcome: 'rejected',
    });
    expect(rejected.decision).toMatchObject({
      outcome: 'denied',
      reason: 'approval_rejected',
    });
    expect(rejected.coverage).not.toHaveBeenCalled();
    const denied = await evaluate(grant, null, false);
    expect(denied.decision.outcome).toBe('denied');
    expect(denied.coverage).not.toHaveBeenCalled();
  });
});
