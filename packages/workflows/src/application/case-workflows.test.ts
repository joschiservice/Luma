import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { CaseActivation, CaseSignal } from '../domain/case-workflow.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import type { WorkflowTriggerRun } from '../domain/workflow.js';
import {
  type CaseWorkflowAdapter,
  createCaseWorkflows,
} from './case-workflows.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-06T12:00:00.000Z');
const context = (id: string, role: 'owner' | 'admin' | 'member' = 'admin') =>
  makeTenantContext(
    { userId: id, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Tenant',
      slug: 'tenant',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: `membership-${id}`, organizationId: tenantId, userId: id },
      role,
    ),
    'request',
  );

const version: ProcessWorkflowVersion = {
  schemaVersion: 2,
  format: 'workflow/2',
  digest: 'b'.repeat(64),
  definition: {
    id: 'test-case',
    name: 'Test case workflow',
    intent: 'Checks a case and finishes.',
    category: 'inventory',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'exception', issueType: 'inventory_mismatch' },
    subjectKind: 'inventory_position',
  },
  inputs: { activationId: 'string', caseId: 'string' },
  context: {
    kind: 'inventory_mismatch',
    fields: { severity: 'string' },
    maxAgeSeconds: 300,
  },
  steps: [
    { id: 'look', kind: 'read', source: 'test', fields: { ok: 'boolean' } },
    { id: 'done', kind: 'end', outcome: 'Done' },
  ],
  provenance: {
    kind: 'native',
    reference: 'test',
    authoredBy: 'Luma',
    evidenceRefs: ['test'],
  },
};

const signal = (id: string, minutesAgo = 1): CaseSignal => ({
  id,
  issueType: 'inventory_mismatch',
  severity: 'medium',
  subject: { kind: 'sku', id: `sku-${id}`, scope: ['location'] },
  firstDetectedAt: new Date(+now - 60 * 60_000).toISOString(),
  lastDetectedAt: new Date(+now - minutesAgo * 60_000).toISOString(),
  open: true,
});

function fixture(
  options: {
    cases?: CaseSignal[];
    transport?: boolean;
    requirementMet?: boolean;
    maxOpenRuns?: number;
  } = {},
) {
  const activations: CaseActivation[] = [];
  const runs = new Map<string, WorkflowTriggerRun>();
  const started: string[] = [];
  const cases = options.cases ?? [];
  const adapter: CaseWorkflowAdapter = {
    version,
    template: { trigger: 't', steps: ['s'], success: 'ok' },
    stepCopy: {},
    requirements: async () => [
      {
        label: 'Connection',
        met: options.requirementMet ?? true,
        detail: 'Connect a store first.',
        fix: null,
      },
    ],
    subject: vi.fn(async (_context, item: CaseSignal) =>
      item.id === 'outside'
        ? null
        : { kind: 'inventory_position', id: item.subject.id },
    ),
    read: async () => ({
      values: { ok: true },
      evidenceRefs: ['e'],
      observedAt: now.toISOString(),
    }),
    action: async () => {
      throw new Error('unused');
    },
    verify: async () => {
      throw new Error('unused');
    },
  };
  const hash = (value: unknown) => JSON.stringify(value);
  const workflows = createCaseWorkflows({
    adapters: [adapter],
    store: {
      list: async () => activations.map((item) => ({ ...item })),
      insert: async (_context, activation) => {
        if (
          activations.some(
            (item) =>
              item.active && item.definitionId === activation.definitionId,
          )
        )
          throw new IdentityError(409, 'CONFLICT', 'Already on.');
        activations.push(activation);

        return activation;
      },
      revoke: async (_context, id, actorId, at) => {
        const found = activations.find((item) => item.id === id);
        if (!found) return null;
        Object.assign(found, {
          active: false,
          revokedBy: actorId,
          revokedAt: at,
        });

        return { ...found };
      },
    },
    runs: {
      version: async () => version,
      find: async (_context, key) => runs.get(key) ?? null,
      run: async (_context, id) =>
        [...runs.values()].find((run) => run.id === id) ?? null,
      insert: async (_context, key, run) => {
        runs.set(key, run);

        return run;
      },
      list: async () => [...runs.values()],
      cancel: async () => null,
      pending: async () => [...runs.values()],
    },
    triggers: {
      fire: async (fireContext, id, request) => {
        const key = hash([
          fireContext.tenantId,
          id,
          version.digest,
          request.subject,
          'exception',
          request.signal.sourceId,
        ]);
        const run = {
          id: `run-${runs.size + 1}`,
          tenantId,
          definitionId: id,
          version: version.version,
          versionDigest: version.digest,
          activationId: String(request.context.inputs.activationId),
          artifactDigest: null,
          trigger: version.applicability.trigger,
          subject: request.subject,
          actor: { kind: 'user' as const, id: fireContext.actor.id },
          context: request.context,
          contextDigest: 'c',
          evidence: request.signal,
          requestDigest: 'r',
          createdAt: now.toISOString(),
          state: 'awaiting_admission' as const,
          triggeredAt: now.toISOString(),
        };
        runs.set(key, run);

        return run;
      },
    },
    steps: { record: async () => undefined, list: async () => new Map() },
    catalog: { publish: vi.fn(async () => undefined) },
    cases: {
      open: async () => cases.filter((item) => item.open),
      get: async (_context, id) => cases.find((item) => item.id === id) ?? null,
      evidence: async () => [],
    },
    identity: {
      refreshContext: async (value) => value,
      resolveWorkflowContext: async (actorId) => context(actorId),
    },
    policies: {
      currentVersion: async () => 'policy-1',
      approvalRequirement: async () =>
        ({
          mode: 'every_action',
          workflowRequired: false,
          threshold: null,
        }) as never,
    },
    audit: { append: vi.fn(async () => undefined) },
    ...(options.transport === false
      ? {}
      : {
          transport: {
            start: async (_context, run) => {
              started.push(run.id);
            },
          },
        }),
    enabled: true,
    hash,
    id: (value) => `id:${value}`,
    now: () => now,
    ...(options.maxOpenRuns ? { maxOpenRuns: options.maxOpenRuns } : {}),
  });
  const turnOn = (id = 'activation-1', actor = 'operator') =>
    workflows.activate(context(actor), 'test-case', {
      id,
      version: version.version,
      reviewedDigest: version.digest,
      policyVersion: 'policy-1',
    });

  return { workflows, runs, started, adapter, activations, turnOn };
}

describe('case workflows', () => {
  it('starts one run per freshly confirmed case and recovers it after a restart', async () => {
    const f = fixture({
      cases: [signal('a'), signal('stale', 10), signal('outside')],
    });
    await f.turnOn();

    await f.workflows.tick(context('operator'));
    await f.workflows.tick(context('operator'));

    expect([...f.runs.values()].map((run) => run.evidence.sourceId)).toEqual([
      'a',
    ]);
    // The second pass re-sends the committed start with its stable ID, which Temporal ignores.
    expect(f.started).toEqual(['run-1', 'run-1']);
    expect([...f.runs.values()][0]).toMatchObject({
      subject: { kind: 'inventory_position', id: 'sku-a' },
      context: { inputs: { activationId: 'activation-1', caseId: 'a' } },
    });
  });

  it('starts nothing for other principals, while turned off or without a worker', async () => {
    const f = fixture({ cases: [signal('a')] });
    await f.workflows.tick(context('operator'));
    expect(f.runs.size).toBe(0);

    await f.turnOn();
    await f.workflows.tick(context('someone-else'));
    expect(f.runs.size).toBe(0);

    const idle = fixture({ cases: [signal('a')], transport: false });
    await expect(idle.turnOn()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('limits unfinished runs per workflow', async () => {
    const f = fixture({
      cases: [signal('a'), signal('b'), signal('c')],
      maxOpenRuns: 2,
    });
    await f.turnOn();
    await f.workflows.tick(context('operator'));

    expect(f.runs.size).toBe(2);
  });

  it('turns on once per request, checks the reviewed version and requirements, and turns off', async () => {
    const f = fixture();
    const first = await f.turnOn();
    expect(await f.turnOn()).toEqual(first);
    await expect(f.turnOn('activation-2')).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      f.workflows.activate(context('operator'), 'test-case', {
        id: 'activation-3',
        version: version.version,
        reviewedDigest: 'f'.repeat(64),
        policyVersion: 'policy-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.workflows.activate(context('member', 'member'), 'test-case', {
        id: 'activation-4',
        version: version.version,
        reviewedDigest: version.digest,
        policyVersion: 'policy-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const off = await f.workflows.revoke(
      context('owner', 'owner'),
      'test-case',
      first.id,
      first.artifactDigest,
    );
    expect(off.active).toBe(false);
    const detail = await f.workflows.detail(context('operator'), 'test-case');
    expect(detail.summary.readiness.enablement).toBe('paused');

    const blocked = fixture({ requirementMet: false });
    await expect(blocked.turnOn()).rejects.toMatchObject({
      statusCode: 409,
      message: 'Connect a store first.',
    });
  });

  it('passes a stop reason to the adapter once the workflow is turned off', async () => {
    const f = fixture({ cases: [signal('a')] });
    const activation = await f.turnOn();
    await f.workflows.tick(context('operator'));
    const [run] = f.runs.values();
    const read = vi.spyOn(f.adapter, 'read');
    await f.workflows.revoke(
      context('operator'),
      'test-case',
      activation.id,
      activation.artifactDigest,
    );

    await f.workflows.activities.read(run!, {
      id: 'look',
      kind: 'read',
      source: 'test',
      fields: { ok: 'boolean' },
    });

    expect(read.mock.calls[0]![1].stop).toBe('activation_revoked');
  });
});
