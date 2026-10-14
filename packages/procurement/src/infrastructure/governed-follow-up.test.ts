import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import {
  createGovernedFollowUps,
  type FollowUpPlan,
  type FollowUpPlanAdmission,
  type FollowUpPlanStore,
} from '../application/governed-follow-up.js';

const tenantId = randomUUID(),
  userId = randomUUID();
const context = makeTenantContext(
  { userId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'AU',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  randomUUID(),
);
const plan: FollowUpPlan = {
  id: randomUUID(),
  tenantId,
  workflowRunId: randomUUID(),
  executionRunId: randomUUID(),
  stepId: 'record-follow-up',
  orderRevision: 2,
  orderScopeFingerprint: 'scope',
  followUpId: randomUUID(),
  orderId: randomUUID(),
  key: 'overdue',
  nextCheckAt: '2026-10-13T12:30:00Z',
  observedAt: '2026-10-13T12:00:00Z',
  expiresAt: '2026-10-13T12:05:00Z',
  requestedBy: userId,
  createdAt: '2026-10-13T12:00:00Z',
  previousProposalId: null,
};

it('refuses inactive or unreleased renewal before creating a misleading successor or new decision', async () => {
  for (const refreshBlock of [
    'workflow_inactive',
    'release_unavailable',
  ] as const) {
    const renew = vi.fn(async () => plan),
      prepare = vi.fn(async () => {}),
      current = vi.fn(async () => null);
    const store: FollowUpPlanStore = {
      head: async () => plan,
      get: async () => plan,
      create: async () => plan,
      renew,
      pending: async () => [plan],
    };
    const admission: FollowUpPlanAdmission = {
      verify: async () => false,
      refreshability: async () => ({ refreshable: false, refreshBlock }),
      reconcile: async () => {},
      prepare,
      execute: async () => ({
        state: 'denied',
        proposalId: plan.id,
        reason: 'blocked',
      }),
      respond: async () => {},
      review: async () => ({
        decisionId: null,
        outcome: 'denied',
        stale: true,
        reason: refreshBlock,
        refreshable: false,
        refreshBlock,
      }),
    };
    const service = createGovernedFollowUps({
      store,
      admission,
      managed: async () => true,
      refreshContext: async (actor) => actor,
      current,
      now: () => new Date('2026-10-13T12:00:00Z'),
      id: randomUUID,
    });
    await expect(
      service.refresh(context, plan.id, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(renew).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(
      await service.record(context, {
        orderRevision: plan.orderRevision,
        orderScopeFingerprint: plan.orderScopeFingerprint,
        runId: plan.workflowRunId,
        stepId: plan.stepId,
        actionId: plan.id,
        orderId: plan.orderId,
        key: plan.key,
        nextCheckAt: plan.nextCheckAt,
        observedAt: plan.observedAt,
      }),
    ).toMatchObject({ state: 'denied', reason: refreshBlock });
    expect(prepare).not.toHaveBeenCalled();
    expect((await service.pending(context))[0]?.review).toMatchObject({
      refreshable: false,
      refreshBlock,
    });
  }
});
