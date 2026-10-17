import type { TenantContext } from '@luma/identity';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { ServiceError } from '@luma/platform';
import { describe, expect, it, vi } from 'vitest';

import type { Approval, PolicyDecision } from '../domain/action.js';
import { createPolicyService } from './policies.js';

const context = makeTenantContext(
  { userId: 'approver', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'AU',
  },
  builtInMembership(
    { id: 'membership', organizationId: 'tenant', userId: 'approver' },
    'owner',
  ),
  'request',
);
const decision = (id: string): PolicyDecision => ({
  correlationId: 'request',
  id,
  tenantId: 'tenant',
  proposalId: `proposal-${id}`,
  actionHash: `hash-${id}`,
  actorId: 'requester',
  capability: 'purchase-orders.submit',
  policyVersion: 'v1',
  outcome: 'approval_required',
  reason: 'approval_required',
  evaluatedAt: '2026-10-14T05:00:00Z',
  validUntil: '2026-10-14T06:00:00Z',
});
const approval: Approval = {
  id: 'approval',
  tenantId: 'tenant',
  proposalId: 'proposal-a',
  actionHash: 'hash-a',
  correlationId: 'request',
  decisionId: 'a',
  policyVersion: 'v1',
  requesterId: 'requester',
  approverId: 'approver',
  outcome: 'approved',
  expiresAt: '2026-10-14T06:00:00Z',
  createdAt: '2026-10-14T05:00:00Z',
};

function service(
  refreshContext: (value: TenantContext) => Promise<TenantContext> = async (
    value,
  ) => value,
) {
  const decisions = new Map([
    ['a', decision('a')],
    ['b', decision('b')],
  ]);
  const refresh = vi.fn(refreshContext);
  const workspacePolicy = vi.fn(async () => ({
    revision: 1,
    required: true,
    requireIndependentApproval: false,
  }));

  return {
    refresh,
    workspacePolicy,
    policies: createPolicyService({
      repository: {
        workspacePolicy,
        pending: async () => [],
        delivered: async () => {},
        saveDecision: async () => {},
        findDecision: async (_tenant, id) => decisions.get(id) ?? null,
        findApproval: async (_tenant, proposalId) =>
          proposalId === approval.proposalId ? approval : null,
        saveApproval: async (value) => value,
      },
      appendEvidence: async () => {},
      refreshContext: refresh,
      now: () => new Date('2026-10-14T05:00:00Z'),
      id: () => 'id',
    }),
  };
}

describe('batch policy decision reads', () => {
  it('returns what single reads return, refreshing authorization once', async () => {
    const single = service().policies;
    const batch = service();
    const ids = ['a', 'b', 'missing', 'a'];

    const read = await batch.policies.decisions(context, ids);

    expect([...read.keys()]).toEqual(['a', 'b', 'missing']);
    for (const id of ids)
      expect(read.get(id)).toEqual(await single.decision(context, id));
    expect(read.get('a')?.approval).toEqual(approval);
    expect(batch.refresh).toHaveBeenCalledOnce();
    expect(batch.workspacePolicy).toHaveBeenCalledOnce();
  });

  it('rejects a context whose membership no longer belongs to the actor', async () => {
    const { policies } = service(async (value) => ({
      ...value,
      actor: { ...value.actor, id: 'someone-else' },
    }));

    await expect(policies.decisions(context, ['a'])).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
});
