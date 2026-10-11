import { describe, expect, it, vi } from 'vitest';

import { processVersion } from '../domain/process.fixture.js';
import { type ProcessActivities, runProcess } from './process-runtime.js';

const version = processVersion;
const run = {
  id: 'run',
  tenantId: 'tenant',
  definitionId: version.definition.id,
  version: version.version,
  versionDigest: version.digest,
  subject: { kind: 'order', id: 'order' },
  actor: { kind: 'user' as const, id: 'user' },
  context: {
    inputs: { quantity: 2 },
    evidence: {
      kind: 'inventory',
      facts: { ready: true },
      observations: [
        {
          id: 'evidence',
          observedAt: '2026-09-27T00:00:00Z',
          source: 'inventory',
        },
      ],
    },
    provenance: { reference: 'source', capturedAt: '2026-09-27T00:00:00Z' },
  },
  contextDigest: 'digest',
  createdAt: '2026-09-27T00:00:00Z',
};

function fixture(
  verification: 'verified' | 'failed' | 'inconclusive' = 'verified',
) {
  const outputs: { stepId: string; state: string }[] = [];
  const activities: ProcessActivities = {
    read: vi.fn(async () => ({
      values: { ready: true },
      evidenceRefs: ['read-1'],
      observedAt: '2026-09-27T00:00:00Z',
    })),
    decision: vi.fn(async () => ({
      state: 'approved' as const,
      decisionId: 'decision',
    })),
    action: vi.fn(async () => ({
      state: 'accepted' as const,
      proposalId: 'proposal',
      receiptId: 'receipt',
    })),
    verify: vi.fn(async () => ({
      state: verification,
      evidenceRefs: ['verification-1'],
      values: { reserved: verification === 'verified' },
    })),
    record: vi.fn(async (_run, output) => {
      outputs.push(output);
    }),
  };
  const clock = {
    now: () => '2026-09-27T00:00:00Z',
    wait: vi.fn(async () => undefined),
    decisionChanged: vi.fn(async () => true),
  };

  return { outputs, activities, clock };
}

describe('process interpreter', () => {
  it('runs ordered steps and records evidence for each effect', async () => {
    const f = fixture();
    const result = await runProcess(run, version, f.activities, f.clock);
    expect(result.state).toBe('verified');
    expect(f.outputs.map((item) => item.stepId)).toEqual([
      ...version.steps.slice(0, -1).map((step) => step.id),
      'settle',
      'finish',
    ]);
    expect(f.outputs.find((item) => item.stepId === 'reserve')).toMatchObject({
      state: 'completed',
      evidenceRefs: ['receipt'],
    });
    expect(f.clock.wait).toHaveBeenCalledWith(5000);
  });
  it.each(['failed', 'inconclusive'] as const)(
    'keeps %s verification distinct from completion',
    async (verification) => {
      const f = fixture(verification);
      const result = await runProcess(run, version, f.activities, f.clock);
      expect(result.state).toBe(
        verification === 'failed'
          ? 'failed_verification'
          : 'inconclusive_verification',
      );
      expect(f.outputs.some((item) => item.stepId === 'finish')).toBe(false);
    },
  );
  it('rejects an altered run binding before any activity', async () => {
    const f = fixture();
    await expect(
      runProcess(
        { ...run, versionDigest: 'other' },
        version,
        f.activities,
        f.clock,
      ),
    ).rejects.toThrow('not bound');
    expect(f.activities.read).not.toHaveBeenCalled();
  });
});

it('keeps an overdue human task alive and consumes its late persisted answer once', async () => {
  const f = fixture();
  let time = Date.parse(run.createdAt);
  const taskVersion = {
    ...version,
    steps: [
      {
        id: 'human',
        kind: 'human_task' as const,
        assignee: { kind: 'person' as const, id: 'user' },
        instructions: 'Confirm picking',
        choices: ['Started'],
        evidence: 'text' as const,
        dueAfterSeconds: 1,
        escalationTarget: { kind: 'role' as const, key: 'admin' },
      },
      { id: 'finish', kind: 'end' as const, outcome: 'answered' },
    ],
  };
  const coordinate = vi
    .fn<NonNullable<ProcessActivities['coordinate']>>()
    .mockResolvedValueOnce({ state: 'pending', evidenceRefs: ['task'] })
    .mockResolvedValueOnce({ state: 'pending', evidenceRefs: ['task'] })
    .mockResolvedValue({
      state: 'completed',
      values: {
        choice: 'Started',
        note: '',
        actorId: 'fallback',
        evidence: 'Warehouse confirmation',
      },
      evidenceRefs: ['task'],
    });
  const states: string[] = [];
  const result = await runProcess(
    run,
    taskVersion,
    { ...f.activities, coordinate },
    {
      now: () => new Date(time).toISOString(),
      wait: async (ms) => {
        time += ms;
      },
      decisionChanged: async (ms) => {
        time += ms;

        return false;
      },
    },
    (progress) => states.push(progress.reason ?? progress.state),
  );
  expect(result.state).toBe('ended');
  expect(states).toContain('human_task_overdue');
  expect(
    f.outputs
      .filter((output) => output.stepId === 'human')
      .map((output) => output.state),
  ).toEqual(['waiting', 'completed']);
  expect(f.activities.action).not.toHaveBeenCalled();
});

it('uses an event delivered before registering the wait without claiming verified success', async () => {
  const f = fixture();
  const waitVersion = {
    ...version,
    steps: [
      {
        id: 'ack',
        kind: 'event_wait' as const,
        eventType: 'supplier.acknowledged',
        correlation: { source: 'literal' as const, value: 'purchase-order' },
        fields: { acknowledged: 'boolean' as const },
        timeoutSeconds: 60,
        onTimeout: 'escalate' as const,
      },
      { id: 'finish', kind: 'end' as const, outcome: 'acknowledged' },
    ],
  };
  const coordinate = vi
    .fn<NonNullable<ProcessActivities['coordinate']>>()
    .mockResolvedValue({
      state: 'completed',
      values: { acknowledged: true },
      evidenceRefs: ['supplier-observation'],
    });
  const result = await runProcess(
    run,
    waitVersion,
    { ...f.activities, coordinate },
    f.clock,
  );
  expect(result.state).toBe('ended');
  expect(f.clock.decisionChanged).not.toHaveBeenCalled();
  expect(f.outputs.map((output) => output.stepId)).toEqual(['ack', 'finish']);
});

it('records an explicit event timeout and never reaches a success step', async () => {
  const f = fixture();
  let time = Date.parse(run.createdAt);
  const waitVersion = {
    ...version,
    steps: [
      {
        id: 'ack',
        kind: 'event_wait' as const,
        eventType: 'supplier.acknowledged',
        correlation: { source: 'literal' as const, value: 'order' },
        fields: {},
        timeoutSeconds: 1,
        onTimeout: 'escalate' as const,
      },
      { id: 'finish', kind: 'end' as const, outcome: 'acknowledged' },
    ],
  };
  const result = await runProcess(
    run,
    waitVersion,
    {
      ...f.activities,
      coordinate: async () => ({ state: 'pending', evidenceRefs: ['wait'] }),
    },
    {
      now: () => new Date(time).toISOString(),
      wait: async (ms) => {
        time += ms;
      },
      decisionChanged: async (ms) => {
        time += ms;

        return false;
      },
    },
  );
  expect(result).toMatchObject({
    state: 'escalated',
    reason: 'event_wait_timeout',
  });
  expect(f.outputs.map((output) => output.state)).toEqual([
    'waiting',
    'escalated',
  ]);
});

it('rechecks temporary unreadability within a bound but never retries an observed failed postcondition', async () => {
  const f = fixture();
  let time = Date.parse(run.createdAt);
  const rechecked = {
    ...version,
    steps: version.steps.map((step) =>
      step.kind === 'verification'
        ? { ...step, recheck: { attempts: 3, intervalSeconds: 1 } }
        : step,
    ),
  };
  const verify = vi
    .fn<ProcessActivities['verify']>()
    .mockResolvedValueOnce({
      state: 'inconclusive',
      values: { reserved: false },
      evidenceRefs: ['unreadable'],
    })
    .mockResolvedValue({
      state: 'verified',
      values: { reserved: true },
      evidenceRefs: ['fresh-read'],
    });
  expect(
    (
      await runProcess(
        run,
        rechecked,
        { ...f.activities, verify },
        {
          ...f.clock,
          now: () => new Date(time).toISOString(),
          wait: async (ms) => {
            time += ms;
          },
        },
      )
    ).state,
  ).toBe('verified');
  expect(verify).toHaveBeenCalledTimes(2);
  const failed = vi.fn<ProcessActivities['verify']>().mockResolvedValue({
    state: 'failed',
    values: { reserved: false },
    evidenceRefs: ['different-postcondition'],
  });
  expect(
    (
      await runProcess(
        run,
        rechecked,
        { ...fixture().activities, verify: failed },
        f.clock,
      )
    ).state,
  ).toBe('failed_verification');
  expect(failed).toHaveBeenCalledTimes(1);
});

it('continues an open handoff after history rollover without repeating prior effects or extending its deadline', async () => {
  const f = fixture();
  const step = {
    id: 'handoff',
    kind: 'human_task' as const,
    assignee: { kind: 'role' as const, key: 'member' },
    instructions: 'Confirm picking.',
    choices: ['Started'],
    evidence: 'text' as const,
    dueAfterSeconds: 1,
    escalationTarget: { kind: 'role' as const, key: 'owner' },
  };
  const continued = {
    ...version,
    steps: [
      ...version.steps.slice(0, 3),
      step,
      { id: 'finish', kind: 'end' as const, outcome: 'Answer recorded' },
    ],
  };
  const checkpoint = {
    stepId: step.id,
    startedAt: run.createdAt,
    outputs: [
      {
        stepId: step.id,
        kind: step.kind,
        state: 'waiting' as const,
        values: {},
        evidenceRefs: ['task'],
        recordedAt: run.createdAt,
      },
    ],
  };
  const coordinate = vi
    .fn<NonNullable<ProcessActivities['coordinate']>>()
    .mockResolvedValue({
      state: 'completed',
      values: {
        choice: 'Started',
        note: '',
        actorId: 'person',
        evidence: 'Warehouse checked.',
      },
      evidenceRefs: ['task'],
    });
  const result = await runProcess(
    run,
    continued,
    { ...f.activities, coordinate },
    f.clock,
    undefined,
    checkpoint,
  );
  expect(result.state).toBe('ended');
  expect(f.activities.action).not.toHaveBeenCalled();
  expect(f.activities.read).not.toHaveBeenCalled();
  expect(coordinate.mock.calls[0]?.[3]).toBe(run.createdAt);
  expect(f.outputs.map((output) => output.state)).toEqual([
    'completed',
    'completed',
  ]);
});
