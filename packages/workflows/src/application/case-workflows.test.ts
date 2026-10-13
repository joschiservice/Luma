import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type {
  CaseActivation,
  CaseSignal,
  WorkflowSignal,
} from '../domain/case-workflow.js';
import type {
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '../domain/process.js';
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

const caseVersion: ProcessWorkflowVersion = {
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

/** The same workflow, started by an owner's follow-ups instead of cases. */
const signalVersion: ProcessWorkflowVersion = {
  ...caseVersion,
  applicability: {
    trigger: { kind: 'event', eventType: 'refund_overdue' },
    subjectKind: 'return',
  },
  inputs: { activationId: 'string', signalId: 'string' },
  context: { ...caseVersion.context, kind: 'refund_overdue' },
};

const followUp = (id: string, open = true): WorkflowSignal => ({
  id,
  issueType: 'refund_overdue',
  severity: 'medium',
  subject: { kind: 'return', id: `return-${id}`, scope: [] },
  firstDetectedAt: new Date(+now - 60 * 60_000).toISOString(),
  lastDetectedAt: now.toISOString(),
  open,
  title: `Refund ${id}`,
  detail: 'No refund is recorded.',
  domain: 'orders',
  record: { kind: 'order', id: `order-${id}` },
});

function fixture(
  options: {
    cases?: CaseSignal[];
    /** Starts from these owner follow-ups instead of cases. */
    signals?: WorkflowSignal[];
    outputs?: Map<string, ProcessStepOutput[]>;
    transport?: boolean;
    requirementMet?: boolean;
    maxOpenRuns?: number;
    /** People whose membership is suspended. */
    suspended?: string[];
    /** The adapter keeps cases it hands to people with the run's principal. */
    caseOwner?: boolean;
    /** Workspace members with their roles; the version then asks a Member and escalates to Admins. */
    members?: { userId: string; role: { id: string; name: string } }[];
    claim?: (id: string, userId: string) => Promise<unknown>;
  } = {},
) {
  const activations: CaseActivation[] = [];
  const runs = new Map<string, WorkflowTriggerRun>();
  const started: string[] = [];
  const cases = options.cases ?? [];
  const signals = options.signals;
  const version = signals
    ? signalVersion
    : options.members
      ? {
          ...caseVersion,
          steps: [
            {
              id: 'ask',
              kind: 'human_task' as const,
              assignee: { kind: 'role' as const, key: 'member' },
              instructions: 'Check the shelf.',
              choices: ['Done'],
              evidence: 'text' as const,
              dueAfterSeconds: 60,
              escalationTarget: { kind: 'role' as const, key: 'admin' },
            },
            ...caseVersion.steps,
          ],
        }
      : caseVersion;
  const adapter: CaseWorkflowAdapter = {
    ...(signals
      ? {
          handover: 'needs_you' as const,
          signals: {
            open: async () => signals.filter((item) => item.open),
            get: async (_context: unknown, id: string) =>
              signals.find((item) => item.id === id) ?? null,
          },
        }
      : {}),
    version,
    ...(options.caseOwner ? { caseOwner: 'principal' as const } : {}),
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
    steps: {
      record: async () => undefined,
      list: async () => options.outputs ?? new Map(),
    },
    catalog: { publish: vi.fn(async () => undefined) },
    cases: {
      open: async () => cases.filter((item) => item.open),
      get: async (_context, id) => cases.find((item) => item.id === id) ?? null,
      evidence: async () => [],
      ...(options.claim
        ? {
            claim: (_context: unknown, id: string, userId: string) =>
              options.claim!(id, userId),
          }
        : {}),
    },
    identity: {
      refreshContext: async (value) => value,
      resolveWorkflowContext: async (actorId) => context(actorId),
      suspendedMembers: async (_context, ids) =>
        new Set(ids.filter((id) => options.suspended?.includes(id))),
      ...(options.members
        ? {
            listMembers: async () =>
              options.members!.map((member) => ({
                id: `membership-${member.userId}`,
                organizationId: tenantId,
                userId: member.userId,
                role: {
                  ...member.role,
                  key: member.role.id as 'member',
                  builtIn: true,
                  revision: 1,
                },
                status: 'active' as const,
              })),
          }
        : {}),
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
        version: caseVersion.version,
        reviewedDigest: 'f'.repeat(64),
        policyVersion: 'policy-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.workflows.activate(context('member', 'member'), 'test-case', {
        id: 'activation-4',
        version: caseVersion.version,
        reviewedDigest: caseVersion.digest,
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

  it('keeps a case it hands to people with the person whose access the run uses', async () => {
    const claim = vi.fn(async () => undefined);
    const f = fixture({ cases: [signal('a')], caseOwner: true, claim });
    await f.turnOn();
    await f.workflows.tick(context('operator'));
    const [run] = f.runs.values();
    const output = (state: ProcessStepOutput['state'], kind = 'human_task') =>
      ({
        stepId: 'ask',
        kind,
        state,
        values: {},
        evidenceRefs: ['e'],
        recordedAt: now.toISOString(),
      }) as ProcessStepOutput;

    await f.workflows.activities.record(run!, output('completed', 'read'));
    expect(claim).not.toHaveBeenCalled();
    await f.workflows.activities.record(run!, output('waiting'));
    await f.workflows.activities.record(run!, output('escalated', 'condition'));
    expect(claim.mock.calls).toEqual([
      ['a', 'operator'],
      ['a', 'operator'],
    ]);

    // Without assignment access, the case keeps its current owner and the run continues.
    claim.mockRejectedValueOnce(new IdentityError(403, 'FORBIDDEN', 'No.'));
    await expect(
      f.workflows.activities.record(run!, output('waiting')),
    ).resolves.toBeUndefined();
    const other = fixture({ cases: [signal('a')], claim });
    await other.turnOn();
    await other.workflows.tick(context('operator'));
    await other.workflows.activities.record(
      [...other.runs.values()][0]!,
      output('waiting'),
    );
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('needs an active person in each role its tasks name before it can be turned on', async () => {
    const missing = fixture({
      cases: [signal('a')],
      members: [{ userId: 'operator', role: { id: 'admin', name: 'Admin' } }],
    });
    const detail = await missing.workflows.detail(
      context('operator'),
      'test-case',
    );
    expect(detail.summary.readiness.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocking',
        message:
          'Nobody active has the Member role, so this workflow’s tasks would have nobody to answer them. Give someone the role in Team.',
      }),
    );
    await expect(missing.turnOn()).rejects.toMatchObject({ statusCode: 409 });

    const staffed = fixture({
      cases: [signal('a')],
      members: [
        { userId: 'operator', role: { id: 'admin', name: 'Admin' } },
        { userId: 'picker', role: { id: 'member', name: 'Member' } },
      ],
    });
    await expect(staffed.turnOn()).resolves.toMatchObject({ active: true });
  });

  it('gives reads the run’s recorded outputs', async () => {
    const outputs = new Map<string, ProcessStepOutput[]>();
    const f = fixture({ cases: [signal('a')], outputs });
    await f.turnOn();
    await f.workflows.tick(context('operator'));
    const [run] = f.runs.values();
    const earlier: ProcessStepOutput = {
      stepId: 'look',
      kind: 'read',
      state: 'completed',
      values: { ok: true },
      evidenceRefs: ['e'],
      recordedAt: now.toISOString(),
    };
    outputs.set(run!.id, [earlier]);
    const read = vi.spyOn(f.adapter, 'read');

    await f.workflows.activities.read(run!, {
      id: 'look',
      kind: 'read',
      source: 'test',
      fields: { ok: 'boolean' },
    });

    expect(read.mock.calls[0]![3]).toEqual([earlier]);
  });

  it('starts one run per owner follow-up, with signal inputs', async () => {
    const f = fixture({
      signals: [followUp('return:a'), followUp('closed', false)],
    });
    await f.turnOn();
    await f.workflows.tick(context('operator'));
    await f.workflows.tick(context('operator'));

    expect([...f.runs.values()]).toEqual([
      expect.objectContaining({
        subject: { kind: 'inventory_position', id: 'return-return:a' },
        evidence: expect.objectContaining({
          kind: 'event',
          sourceId: 'return:a',
        }),
        context: expect.objectContaining({
          inputs: { activationId: 'activation-1', signalId: 'return:a' },
          evidence: expect.objectContaining({
            kind: 'refund_overdue',
            observations: [
              expect.objectContaining({ id: 'id:signal:return:a' }),
            ],
          }),
        }),
      }),
    ]);
    const detail = await f.workflows.detail(context('operator'), 'test-case');
    expect(detail.summary.readiness.coverage.explanation).toContain(
      'its owner reports',
    );
  });

  it('lists a handed-over run only while its follow-up is open', async () => {
    const outputs = new Map<string, ProcessStepOutput[]>();
    const signals = [followUp('return:a')];
    const f = fixture({ signals, outputs });
    await f.turnOn();
    await f.workflows.tick(context('operator'));
    outputs.set('run-1', [
      {
        stepId: 'look',
        kind: 'condition',
        state: 'escalated',
        values: {},
        evidenceRefs: ['e'],
        recordedAt: now.toISOString(),
        reason: 'condition_not_met',
      } as ProcessStepOutput,
    ]);

    expect(await f.workflows.handovers(context('member', 'member'))).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        handedOverAt: now.toISOString(),
        signal: expect.objectContaining({ title: 'Refund return:a' }),
      }),
    ]);
    signals[0]!.open = false;
    expect(await f.workflows.handovers(context('operator'))).toEqual([]);
    // Case workflows ask through their case instead.
    expect(await fixture().workflows.handovers(context('operator'))).toEqual(
      [],
    );
  });

  it('rejects an adapter whose trigger does not match where it starts from', () => {
    expect(() => fixture({ signals: [] }).workflows).not.toThrow();
    const f = fixture();
    expect(() =>
      createCaseWorkflows({
        ...({} as Parameters<typeof createCaseWorkflows>[0]),
        adapters: [{ ...f.adapter, version: signalVersion }],
      }),
    ).toThrow('event trigger and signal inputs');
  });

  it('needs a new owner while the person who turned it on is suspended', async () => {
    const f = fixture({ cases: [signal('a')], suspended: ['operator'] });
    await f.turnOn();

    const detail = await f.workflows.detail(context('admin'), 'test-case');
    expect(detail.summary.readiness).toMatchObject({
      enablement: 'enabled',
      state: 'blocked',
      issues: [expect.objectContaining({ code: 'owner_suspended' })],
    });
    expect(detail.summary.blockers[0]).toContain('needs a new owner');

    const restored = fixture({ cases: [signal('a')] });
    await restored.turnOn();
    expect(
      (await restored.workflows.detail(context('admin'), 'test-case')).summary
        .readiness.issues,
    ).toEqual([]);
  });

  it('shows an unreadable source as unknown and keeps other workflows starting', async () => {
    const f = fixture({ signals: [followUp('return:a')] });
    await f.turnOn();
    f.adapter.signals!.open = async () => {
      throw new Error('permission denied');
    };
    f.adapter.requirements = async () => {
      throw new Error('permission denied');
    };

    const detail = await f.workflows.detail(context('operator'), 'test-case');
    expect(detail.summary.readiness.coverage.explanation).toContain(
      'couldn’t read how many are open',
    );
    expect(detail.summary.blockers).toContain(
      'Luma couldn’t check what this workflow needs right now. Try again shortly.',
    );
    await expect(f.workflows.tick(context('operator'))).rejects.toThrow(
      'Some case workflows could not run',
    );
  });
});
