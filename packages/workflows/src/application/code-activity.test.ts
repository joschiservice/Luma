import { expect, it, vi } from 'vitest';

import {
  type CodeCall,
  CodeRequestStopped,
  type CodeRunner,
  type CodeStep,
  type CodeTelemetry,
} from '../domain/code-step.js';
import { processVersion } from '../domain/process.fixture.js';
import { type CodeJournal, createCodeActivity } from './code-activity.js';
import type { ProcessActivities } from './process-runtime.js';
import { presentTriggerRun } from './trigger-presentation.js';

const step: CodeStep = {
  id: 'code',
  kind: 'code',
  runtime: 'wasmtime-49.0.1/javy-9.1.0/typescript-5.9.3/1',
  source: '',
  artifactDigest: 'a'.repeat(64),
  fields: { reserved: 'boolean' },
  grants: ['reserve'],
  limits: {
    fuel: 10000,
    memoryBytes: 67108864,
    wallTimeMs: 1000,
    maxRequests: 1,
  },
};
const run = {
  id: 'run',
  tenantId: 'tenant',
  definitionId: processVersion.definition.id,
  version: processVersion.version,
  versionDigest: processVersion.digest,
  subject: { kind: 'order', id: 'order' },
  actor: { kind: 'user' as const, id: 'user' },
  context: {
    inputs: { quantity: 2 },
    evidence: { kind: 'inventory', facts: { ready: true }, observations: [] },
    provenance: {
      reference: 'fixture',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  contextDigest: 'digest',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function fixture(completedOutcome: CodeTelemetry['outcome'] = 'completed') {
  const saved: CodeCall[] = [];
  const journal: CodeJournal = {
    result: vi.fn(async () => null),
    calls: vi.fn(async () => [...saved]),
    append: vi.fn(async (_run, _step, _index, call) => {
      saved.push(call);

      return call;
    }),
    finish: vi.fn(async (_run, _step, _input, result) => result),
    cancelled: vi.fn(async () => false),
  };
  const activities = {
    read: vi.fn(async () => ({
      values: { ready: true },
      evidenceRefs: ['read'],
      observedAt: new Date().toISOString(),
    })),
    action: vi.fn<ProcessActivities['action']>(async () => ({
      state: 'accepted' as const,
      proposalId: 'proposal',
      receiptId: 'receipt',
    })),
    verify: vi.fn(async () => ({
      state: 'verified' as const,
      values: { reserved: true },
      evidenceRefs: ['verified'],
    })),
  };
  const runner: CodeRunner = {
    run: async (code, _input, controls) => {
      let values = {};
      let outcome: CodeTelemetry['outcome'] = completedOutcome;
      try {
        if (controls.signal?.aborted) throw new CodeRequestStopped('cancelled');
        values = (await controls.request('reserve')) as object;
      } catch (error) {
        if (!(error instanceof CodeRequestStopped)) throw error;
        outcome = error.outcome;
      }

      return {
        values,
        telemetry: {
          runtime: code.runtime,
          artifactDigest: code.artifactDigest,
          inputDigest: 'b'.repeat(64),
          wallTimeMs: 1,
          requests: 1,
          outcome,
        },
      };
    },
  };
  const authorize = vi.fn(async () => undefined);

  return {
    activities,
    journal,
    runner,
    authorize,
    execute: createCodeActivity({ activities, journal, runner, authorize }),
  };
}

it('journals verified capability replies and replays without another effect', async () => {
  const f = fixture();
  const first = await f.execute(run, processVersion, step, []);
  expect(first.state).toBe('completed');
  expect(first.telemetry.verifiedActions).toBe(1);
  const replay = await f.execute(run, processVersion, step, []);
  expect(replay.values).toEqual({ reserved: true });
  expect(f.activities.action).toHaveBeenCalledTimes(1);
  expect(f.activities.verify).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenCalledTimes(4);
});

it('suspends approval without recording a terminal outcome or verifying an unaccepted action', async () => {
  const f = fixture();
  f.activities.action.mockResolvedValueOnce({
    state: 'awaiting_approval',
    proposalId: 'proposal',
    decisionId: 'decision',
  } as never);
  expect((await f.execute(run, processVersion, step, [])).state).toBe(
    'awaiting_approval',
  );
  expect(f.activities.verify).not.toHaveBeenCalled();
  expect(f.journal.finish).not.toHaveBeenCalled();
  expect((await f.execute(run, processVersion, step, [])).state).toBe(
    'completed',
  );
});

it('rejects ungranted requests and cancellation before invoking business actions', async () => {
  const f = fixture();
  expect(
    (await f.execute(run, processVersion, { ...step, grants: [] }, [])).state,
  ).toBe('failed');
  f.journal.cancelled = vi.fn(async () => true);
  expect((await f.execute(run, processVersion, step, [])).state).toBe('failed');
  expect(f.activities.action).not.toHaveBeenCalled();
});

it('never journals failed verification as a successful capability reply', async () => {
  const f = fixture();
  f.activities.verify.mockResolvedValueOnce({
    state: 'failed',
    values: { reserved: false },
    evidenceRefs: ['failed'],
  } as never);
  const result = await f.execute(run, processVersion, step, []);
  expect(result.state).toBe('failed');
  expect(result.telemetry.verifiedActions).toBe(0);
  expect(f.journal.append).not.toHaveBeenCalled();
});

it('finishes cancelled replay and preserves previously verified effects', async () => {
  const f = fixture();
  await f.execute(run, processVersion, step, []);
  f.journal.cancelled = vi.fn(async () => true);
  const result = await f.execute(run, processVersion, step, []);
  expect(result.telemetry.outcome).toBe('cancelled');
  expect(result.telemetry.verifiedActions).toBe(1);
  expect(result.evidenceRefs).toContain('verified');
  expect(f.activities.action).toHaveBeenCalledTimes(1);
  expect(f.journal.finish).toHaveBeenCalledTimes(2);
});

it('retries transient host failures without storing a permanent denial', async () => {
  const f = fixture();
  f.activities.action.mockRejectedValueOnce(
    new Error('Temporary connector failure'),
  );
  await expect(f.execute(run, processVersion, step, [])).rejects.toThrow(
    'Temporary connector failure',
  );
  expect(f.journal.finish).not.toHaveBeenCalled();
  expect((await f.execute(run, processVersion, step, [])).state).toBe(
    'completed',
  );
  expect(f.activities.action).toHaveBeenCalledTimes(2);
});

it('reports verified actions even when the enclosing code later fails', async () => {
  const f = fixture('code_error');
  const result = await f.execute(run, processVersion, step, []);
  expect(result.state).toBe('failed');
  expect(result.telemetry.verifiedActions).toBe(1);
  const presented = presentTriggerRun(
    {
      ...run,
      activationId: null,
      artifactDigest: null,
      trigger: { kind: 'manual' },
      evidence: { sourceId: 'manual', occurredAt: run.createdAt },
      requestDigest: 'request',
      state: 'awaiting_admission',
      triggeredAt: run.createdAt,
    },
    [
      {
        stepId: step.id,
        kind: 'code',
        state: 'escalated',
        values: result.values,
        evidenceRefs: result.evidenceRefs,
        recordedAt: run.createdAt,
        code: result.telemetry,
      },
    ],
  );
  expect(presented.processState).toBe('escalated');
  expect(presented.execution).toBe('accepted');
  expect(presented.story.action).toBe(
    'The admitted action has a recorded receipt.',
  );
});

it('does not persist cancellation when its status lookup fails', async () => {
  const f = fixture();
  vi.mocked(f.journal.cancelled)
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('Database unavailable'));
  const original = f.runner.run;
  f.runner.run = async (code, input, controls) => {
    await new Promise<void>((resolve) =>
      controls.signal!.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );

    return original(code, input, controls);
  };
  await expect(f.execute(run, processVersion, step, [])).rejects.toThrow(
    'Code cancellation status unavailable',
  );
  expect(f.journal.finish).not.toHaveBeenCalled();
  expect(f.activities.action).not.toHaveBeenCalled();
});

it('records observe-only as terminal and never verifies or repeats the capability on replay', async () => {
  const f = fixture();
  f.activities.action.mockResolvedValue({
    state: 'not_executed',
    proposalId: 'proposal',
    reason: 'observe_only',
  });
  const result = await f.execute(run, processVersion, step, []);
  expect(result).toMatchObject({
    state: 'not_executed',
    evidenceRefs: [step.artifactDigest, 'proposal'],
  });
  expect(result.telemetry.verifiedActions).toBe(0);
  expect(f.activities.verify).not.toHaveBeenCalled();
  expect(f.journal.append).not.toHaveBeenCalled();
  expect(f.journal.finish).toHaveBeenCalledOnce();
  vi.mocked(f.journal.result).mockResolvedValue(result);
  expect(await f.execute(run, processVersion, step, [])).toEqual(result);
  expect(f.activities.action).toHaveBeenCalledOnce();
});
