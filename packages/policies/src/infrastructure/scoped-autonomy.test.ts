import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import { expect, it, vi } from 'vitest';

import {
  type AutonomyRepository,
  createScopedAutonomy,
} from '../application/scoped-autonomy.js';
import type { ProposedAction } from '../domain/action.js';
import type { ScopedResponsibilityFacts } from '../domain/scoped-autonomy.js';

const tenantId = randomUUID(),
  userId = randomUUID();
const context = makeTenantContext(
  { userId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  randomUUID(),
);
const action: ProposedAction = {
  schemaVersion: 1,
  id: randomUUID(),
  tenantId,
  capability: 'procurement.follow-up.record',
  capabilityVersion: '0',
  connectionId: tenantId,
  target: { kind: 'purchase_order', id: randomUUID() },
  parameters: {},
  preconditions: { evidenceRefs: [], validUntil: '2026-10-13T12:05:00Z' },
  expectedPostcondition: { recorded: true },
  risk: 'low',
  proposedBy: { kind: 'user', id: userId },
  expiresAt: '2026-10-13T12:05:00Z',
};

function fixture({
  enabled = false,
  epoch = 0,
  facts = null,
}: {
  enabled?: boolean;
  epoch?: number;
  facts?: ScopedResponsibilityFacts | null;
} = {}) {
  const repository: AutonomyRepository = {
    list: async () => [],
    history: async () => [],
    proposal: async () => null,
    epoch: async () => epoch,
    pending: async () => [],
    delivered: async () => {},
    mutate: async () => {
      throw new Error('Unexpected mutation');
    },
    recordProposal: async () => {},
    recordReview: async () => {},
  };
  const read = vi.fn(async () => facts);
  const service = createScopedAutonomy({
    repository,
    refreshContext: async (c) => c,
    enabled: async () => enabled,
    facts: read,
    hash: () => 'hash',
    appendAudit: async () => {},
    now: () => new Date('2026-10-13T12:00:00Z'),
  });

  return { service, read };
}

it('flag rollback blocks both persisted enrollment and explicitly governed intent, without reading or taking the legacy path', async () => {
  const enrolled = fixture({ epoch: 1 });
  expect(await enrolled.service.managed(tenantId)).toBe(true);
  expect(await enrolled.service.evaluate(context, action, 'low')).toMatchObject(
    { outcome: 'denied', reason: 'paused', admission: null },
  );
  const explicitlyGoverned = fixture();
  expect(
    await explicitlyGoverned.service.evaluate(
      context,
      { ...action, parameters: { governed: true } },
      'low',
    ),
  ).toMatchObject({ outcome: 'denied', reason: 'paused' });
  expect(enrolled.read).not.toHaveBeenCalled();
  expect(explicitlyGoverned.read).not.toHaveBeenCalled();
});

it('permits legacy direct behavior only before any responsibility has ever enrolled', async () => {
  const neverEnrolled = fixture();
  expect(await neverEnrolled.service.managed(tenantId)).toBe(false);
  expect(
    await neverEnrolled.service.evaluate(context, action, 'low'),
  ).toBeNull();
});

it('fails closed when current trusted facts do not match the bound record or connection', async () => {
  const facts: ScopedResponsibilityFacts = {
    recordId: randomUUID(),
    connectionId: tenantId,
    supplierId: null,
    locationId: null,
    quantity: '1',
    unit: 'follow_up',
    exposure: null,
    observedAt: '2026-10-13T12:00:00Z',
    complete: true,
    environment: 'unknown',
  };
  const f = fixture({ enabled: true, facts });
  expect(await f.service.evaluate(context, action, 'low')).toMatchObject({
    outcome: 'denied',
    reason: 'out_of_scope',
    admission: null,
  });
});

it('earned autonomy is bound to the current reviewed declaration, and existing proposal evidence cannot be reclassified', async () => {
  const proof = {
    basis: 'reviewed_workspace_declaration' as const,
    connectionId: randomUUID(),
    connectionVersion: 1,
    credentialVersion: 1,
    sourceBinding: 'source-v1',
    declarationRevision: 1,
    evidenceId: randomUUID(),
  };
  const facts: ScopedResponsibilityFacts = {
    recordId: action.target.id,
    connectionId: tenantId,
    supplierId: null,
    locationId: null,
    quantity: '1',
    unit: 'follow_up',
    exposure: null,
    observedAt: '2026-10-13T12:00:00Z',
    complete: true,
    environment: 'live',
    environmentProvenance: proof,
  };
  const policy = {
    id: randomUUID(),
    tenantId,
    revision: 1,
    name: 'Reviewed notes',
    scope: {
      capability: 'procurement.follow-up.record' as const,
      connectionIds: [tenantId],
      supplierIds: [],
      locationIds: [],
      recordIds: [],
      unit: 'follow_up' as const,
      perActionQuantity: '1',
      dailyQuantity: '100',
      money: null,
      maxEvidenceAgeSeconds: 300,
    },
    scopeHash: 'scope',
    mode: 'assisted' as 'assisted' | 'autonomous',
    paused: false,
    pausedConnectionIds: [],
    revoked: false,
    circuitReason: null,
    updatedAt: '2026-10-13T12:00:00Z',
    updatedBy: userId,
  };
  const history = Array.from({ length: 20 }, () => ({
    proposalId: randomUUID(),
    policyId: policy.id,
    scopeHash: 'scope',
    facts,
    actionRisk: 'low' as const,
    minimumRisk: 'low' as const,
    review: 'accepted' as const,
    verification: 'passed' as const,
    dispatch: 'dispatched' as const,
    at: '2026-10-13T11:59:00Z',
  }));
  let current: {
    environment: ScopedResponsibilityFacts['environment'];
    provenance: ScopedResponsibilityFacts['environmentProvenance'];
  } = { environment: 'live', provenance: proof };
  const repository: AutonomyRepository = {
    list: async () => [policy],
    history: async () => history,
    proposal: async (_, id) => history.find((e) => e.proposalId === id) ?? null,
    epoch: async () => 1,
    pending: async () => [],
    delivered: async () => {},
    mutate: async (
      _ctx,
      _id,
      _command,
      _fingerprint,
      _revision,
      _reason,
      apply,
    ) => apply(policy, history),
    recordProposal: async () => {},
    recordReview: async () => {},
  };
  const service = createScopedAutonomy({
    repository,
    refreshContext: async (c) => c,
    enabled: async () => true,
    facts: async () => ({
      ...facts,
      environment: current.environment,
      environmentProvenance: current.provenance ?? null,
    }),
    environment: async () => current,
    hash: JSON.stringify,
    appendAudit: async () => {},
    now: () => new Date('2026-10-13T12:00:00Z'),
  });
  const promote = () =>
    service.control(context, policy.id, {
      commandId: randomUUID(),
      expectedRevision: 1,
      kind: 'promote',
      reason: 'Reviewed independently verified record',
    });
  expect((await promote()).mode).toBe('autonomous');
  policy.mode = 'autonomous';
  expect((await service.evaluate(context, action, 'low'))?.outcome).toBe(
    'allowed',
  );
  for (const changed of [
    { environment: 'unknown' as const, provenance: null },
    {
      environment: 'synthetic' as const,
      provenance: {
        ...proof,
        basis: 'simulation_manifest' as const,
        declarationRevision: null,
        evidenceId: null,
      },
    },
    {
      environment: 'live' as const,
      provenance: {
        ...proof,
        credentialVersion: 2,
        connectionVersion: 2,
        sourceBinding: 'source-v2',
        declarationRevision: 2,
        evidenceId: randomUUID(),
      },
    },
  ]) {
    current = changed;
    await expect(promote()).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.evaluate(context, action, 'low'))?.outcome).toBe(
      'denied',
    );
    expect(
      await service.evidenceCurrent(context, history[0]!.proposalId, current),
    ).toBe(false);
  }
  expect(history[0]!.facts.environmentProvenance).toEqual(proof);
  const unknown = {
    ...history[0]!,
    proposalId: randomUUID(),
    facts: {
      ...facts,
      environment: 'unknown' as const,
      environmentProvenance: null,
    },
  };
  history.push(unknown);
  current = { environment: 'live', provenance: proof };
  expect(
    await service.evidenceCurrent(context, unknown.proposalId, current),
  ).toBe(false);
});
