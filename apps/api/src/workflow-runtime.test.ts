import { describe, expect, it, vi } from 'vitest';
import { makeTenantContext } from '#modules/identity/composition';
import { IdentityError } from '#modules/identity/index';
import { createExceptionActivities } from '#modules/workflows/composition';
import type {
  ExceptionWorkflowInput,
  ProposalReference,
} from '#modules/workflows/index';
import type { Diagnosis, Incident } from '#modules/exceptions/index';
import type { ProposedAction } from '#modules/policies/index';
import type { ExecutionRecord } from '#modules/execution/index';

const context = makeTenantContext(
  { userId: 'requester', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    dataRegion: 'EU',
    status: 'active',
  },
  {
    id: 'membership',
    organizationId: 'tenant',
    userId: 'requester',
    role: 'owner',
  },
  'request',
);
const input: ExceptionWorkflowInput = {
  tenantId: 'tenant',
  userId: 'requester',
  requestId: 'request',
  source: { kind: 'incident', id: 'incident' },
};
const proposal: ProposalReference = {
  id: 'proposal',
  revision: 1,
  expiresAt: '2026-09-20T00:00:00.000Z',
};
const diagnosis: Diagnosis = {
  schemaVersion: 1,
  exceptionId: 'incident',
  revision: 1,
  status: 'ready',
  reason: 'diagnosed',
  superseded: false,
  summary: 'Fixture',
  detectorDecision: { decision: 'detect', severity: 'high', reason: 'fixture' },
  affected: { kind: 'sku', id: 'sku', scope: [] },
  facts: [],
  hypotheses: [],
  constraints: [],
  impact: {
    observed: [],
    potential: [],
    exposedQuantity: null,
    unit: null,
    cost: null,
  },
  nextSteps: [],
  attention: {
    suggested: false,
    reason: 'none',
    evidenceRefs: [],
    dueAt: null,
  },
  provenance: {
    generatedAt: '2026-09-18T00:00:00Z',
    engineVersion: 'v1',
    ruleVersion: 'v1',
    configVersion: 'v1',
    mappingVersions: [],
    evidence: [],
    validUntil: proposal.expiresAt,
    model: { status: 'disabled', model: null, promptVersion: null },
    reread: { status: 'not_requested', retryAfter: null },
  },
};
const action: ProposedAction = {
  schemaVersion: 1,
  id: proposal.id,
  tenantId: context.tenantId,
  capability: 'inventory.adjust',
  capabilityVersion: 'v1',
  connectionId: 'connection',
  target: { kind: 'sku', id: 'sku' },
  parameters: { amount: 4 },
  preconditions: {
    evidenceRefs: ['observation'],
    validUntil: proposal.expiresAt,
  },
  expectedPostcondition: { amount: 4 },
  risk: 'medium',
  proposedBy: { kind: 'user', id: context.actor.id },
  expiresAt: proposal.expiresAt,
};
function fixture() {
  const deps = {
    identity: { resolveWorkflowContext: vi.fn().mockResolvedValue(context) },
    exceptions: {
      get: vi
        .fn()
        .mockResolvedValue({ id: 'incident', state: 'detected' } satisfies Pick<
          Incident,
          'id' | 'state'
        >),
      ingest: vi.fn(),
      list: vi.fn(),
      evidence: vi.fn(),
      verify: vi.fn().mockResolvedValue(true),
      resolve: vi.fn(),
    },
    diagnoses: {
      run: vi.fn().mockResolvedValue(diagnosis),
      get: vi.fn().mockResolvedValue(diagnosis),
      history: vi.fn(),
    },
    execution: {
      get: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ state: 'succeeded' }),
      reconcile: vi.fn().mockResolvedValue({ state: 'succeeded' }),
    },
    bindings: {
      recordWorkflow: vi.fn(),
      loadDetection: vi.fn(),
      proposals: {
        prepare: vi.fn().mockResolvedValue(action),
        get: vi
          .fn()
          .mockResolvedValue({ exceptionId: 'incident', revision: 1, action }),
      },
    },
  };
  return { deps, activities: createExceptionActivities(deps) };
}
describe('durable activity boundaries', () => {
  it('reconstructs authorization for every step and returns only references', async () => {
    const { deps, activities } = fixture();
    expect(await activities.detect(input)).toBe('incident');
    expect(deps.bindings.recordWorkflow).toHaveBeenCalledWith(
      context,
      'incident',
      input.source,
    );
    expect(await activities.diagnose(input, 'incident')).toEqual({
      status: 'ready',
      revision: 1,
      verificationRequired: false,
      retryAfter: null,
    });
    expect(await activities.propose(input, 'incident', 1)).toEqual(proposal);
    expect(await activities.execute(input, 'incident', proposal)).toEqual({
      state: 'succeeded',
    });
    await activities.verify(input, 'incident');
    expect(deps.identity.resolveWorkflowContext).toHaveBeenCalledTimes(5);
    expect(deps.identity.resolveWorkflowContext).toHaveBeenCalledWith(
      'requester',
      'tenant',
      'request',
    );
    expect(deps.execution.execute).toHaveBeenCalledWith(context, action);
  });
  it('uses the persisted detection request and preserves detection deduplication', async () => {
    const { deps, activities } = fixture();
    const request = { key: 'immutable-reference' };
    deps.bindings.loadDetection.mockResolvedValue(request);
    deps.exceptions.ingest.mockResolvedValue({ incident: { id: 'incident' } });
    expect(
      await activities.detect({
        ...input,
        source: { kind: 'detection', id: 'delivery' },
      }),
    ).toBe('incident');
    expect(deps.bindings.loadDetection).toHaveBeenCalledWith(
      context,
      'delivery',
    );
    expect(deps.exceptions.ingest).toHaveBeenCalledWith(context, request);
  });
  it.each([
    { superseded: true },
    { revision: 2 },
    { status: 'insufficient_evidence' },
  ])('withholds stale proposals: %j', async (change) => {
    const { deps, activities } = fixture();
    deps.diagnoses.get.mockResolvedValue({ ...diagnosis, ...change });
    expect(await activities.execute(input, 'incident', proposal)).toEqual({
      state: 'denied',
    });
    expect(await activities.propose(input, 'incident', 1)).toBeNull();
    expect(deps.execution.execute).not.toHaveBeenCalled();
  });
  it('recovers a reserved effect even when diagnosis and proposal sources changed', async () => {
    const { deps, activities } = fixture();
    deps.execution.get.mockResolvedValue({
      state: 'reconciliation_required',
      record: { state: 'prepared' } satisfies Pick<ExecutionRecord, 'state'>,
    });
    deps.diagnoses.get.mockResolvedValue(null);
    deps.bindings.proposals.get.mockResolvedValue(null);
    expect(await activities.execute(input, 'incident', proposal)).toEqual({
      state: 'reconciliation_required',
    });
    expect(deps.execution.execute).not.toHaveBeenCalled();
    expect(deps.bindings.proposals.get).not.toHaveBeenCalled();
  });
  it('rejects a proposal bound to a different case', async () => {
    const { deps, activities } = fixture();
    deps.bindings.proposals.get.mockResolvedValue({
      exceptionId: 'other',
      revision: 1,
      action,
    });
    await expect(
      activities.execute(input, 'incident', proposal),
    ).rejects.toThrow('binding');
    expect(deps.execution.execute).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant proposals', async () => {
    const { deps, activities } = fixture();
    deps.bindings.proposals.prepare.mockResolvedValue({
      ...action,
      tenantId: 'other',
    });
    await expect(activities.propose(input, 'incident', 1)).rejects.toThrow(
      'Resource not found',
    );
  });
  it('rejects revoked access before loading or dispatching an action', async () => {
    const { deps, activities } = fixture();
    deps.identity.resolveWorkflowContext.mockRejectedValue(
      new IdentityError(404, 'NOT_FOUND', 'Organization not found'),
    );
    await expect(
      activities.execute(input, 'incident', proposal),
    ).rejects.toThrow('Organization not found');
    expect(deps.bindings.proposals.get).not.toHaveBeenCalled();
    expect(deps.execution.execute).not.toHaveBeenCalled();
  });
  it('accepts verification replay but never treats human disposition as verified', async () => {
    const { deps, activities } = fixture();
    deps.exceptions.get.mockResolvedValue({
      state: 'resolved',
      resolution: { kind: 'verification' },
    });
    expect(await activities.verify(input, 'incident')).toBe(true);
    deps.exceptions.get.mockResolvedValue({
      state: 'resolved',
      resolution: { kind: 'human_disposition' },
    });
    expect(await activities.verify(input, 'incident')).toBe(false);
    expect(deps.exceptions.verify).not.toHaveBeenCalled();
  });
});

it('deduplicates starts and scopes commands to the current tenant', async () => {
  const { TestWorkflowEnvironment } = await import('@temporalio/testing');
  const { createExceptionClient, createDeskWorkflowReader } =
    await import('#modules/workflows/composition');
  const env = await TestWorkflowEnvironment.createLocal();
  const identity = {
    refreshContext: vi.fn(async (value: typeof context) => value),
  };
  const client = await createExceptionClient(
    {
      address: env.address,
      namespace: 'default',
      taskQueue: 'scope-test',
      dataRegion: 'EU',
    },
    identity,
  );
  const reader = createDeskWorkflowReader(
    {
      address: env.address,
      namespace: 'default',
      taskQueue: 'scope-test',
      dataRegion: 'EU',
    },
    identity,
  );
  try {
    expect(await reader.get(context, 'missing-incident')).toBeNull();
    const first = await client.start(context, input.source);
    expect(await client.start(context, input.source)).toEqual(first);
    const other = makeTenantContext(
      { userId: 'requester', sessionId: 'session' },
      {
        id: 'other',
        name: 'Other',
        slug: 'other',
        dataRegion: 'EU',
        status: 'active',
      },
      {
        id: 'other-member',
        organizationId: 'other',
        userId: 'requester',
        role: 'owner',
      },
      'other-request',
    );
    expect(await client.start(other, input.source)).not.toEqual(first);
    await env.client.workflow.getHandle(first.workflowId).terminate();
    expect(await client.start(context, input.source)).toEqual(first);
    const member = makeTenantContext(
      { userId: 'reader', sessionId: 'reader-session' },
      {
        id: 'tenant',
        name: 'Fixture',
        slug: 'fixture',
        dataRegion: 'EU',
        status: 'active',
      },
      {
        id: 'reader-membership',
        organizationId: 'tenant',
        userId: 'reader',
        role: 'member',
      },
      'reader-request',
    );
    expect(await reader.get(member, 'incident')).toMatchObject({
      phase: 'escalated',
      reason: 'workflow_interrupted',
    });
    await expect(client.start(member, input.source)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await reader.get(other, 'missing-incident')).toBeNull();
    const history = await env.client.workflow
      .getHandle(first.workflowId)
      .fetchHistory();
    expect(
      history.events?.filter(
        (event) => event.workflowExecutionStartedEventAttributes,
      ),
    ).toHaveLength(1);
    identity.refreshContext.mockRejectedValue(
      new IdentityError(404, 'NOT_FOUND', 'Organization not found'),
    );
    await expect(client.notifyApproval(context, input.source)).rejects.toThrow(
      'Organization not found',
    );
    await expect(client.progress(context, input.source)).rejects.toThrow(
      'Organization not found',
    );
  } finally {
    await reader.close();
    await client.close();
    await env.teardown();
  }
}, 30_000);
