import { randomBytes, randomUUID } from 'node:crypto';

import {
  AccountDisabledError,
  builtInMembership,
  IdentityError,
  makeTenantContext,
  MembershipSuspendedError,
  WorkspaceInactiveError,
} from '@luma/identity';
import type {
  ExceptionActivities,
  ExceptionWorkflowInput,
  WorkflowProgress,
} from '@luma/resolution';
import { WorkflowInputError } from '@luma/resolution';
import { ApplicationFailure } from '@temporalio/common';
import {
  MockActivityEnvironment,
  TestWorkflowEnvironment,
} from '@temporalio/testing';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { bundleWorkflowCode, DefaultLogger, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  temporalDataConverter,
  type TemporalPayloadEncryption,
} from './payload-codec.js';
import {
  createExceptionClient,
  createExceptionWorker,
  temporalActivities,
  workflowPath,
} from './runtime.js';

let env: TestWorkflowEnvironment;

let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  bundle = await bundleWorkflowCode({ workflowsPath: workflowPath() });
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

const input: ExceptionWorkflowInput & { dataRegion: 'AU' } = {
  dataRegion: 'AU',
  tenantId: 'tenant',
  userId: 'requester',
  requestId: 'request',
  source: { kind: 'incident', id: 'incident' },
};

function fixture() {
  return {
    detect: vi
      .fn<ExceptionActivities['detect']>()
      .mockResolvedValue('incident'),
    diagnose: vi.fn<ExceptionActivities['diagnose']>().mockResolvedValue({
      status: 'ready',
      revision: 1,
      verificationRequired: false,
      retryAfter: null,
    }),
    propose: vi.fn<ExceptionActivities['propose']>().mockResolvedValue({
      id: 'proposal',
      revision: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    execute: vi
      .fn<ExceptionActivities['execute']>()
      .mockResolvedValue({ state: 'succeeded' }),
    reconcile: vi
      .fn<ExceptionActivities['reconcile']>()
      .mockResolvedValue({ state: 'succeeded' }),
    verify: vi.fn<ExceptionActivities['verify']>().mockResolvedValue(true),
  };
}

async function run(
  activities: ExceptionActivities,
  environment = env,
  workflowInput = input,
) {
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });

  return worker.runUntil(
    () =>
      environment.client.workflow.execute('exceptionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [workflowInput],
      }) as Promise<WorkflowProgress>,
  );
}

it('verifies the business outcome after a successful effect and replays recorded history', async () => {
  const activities = fixture();
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('exceptionWorkflow', {
      workflowId: randomUUID(),
      taskQueue,
      args: [input],
    });
    expect(await handle.result()).toMatchObject({
      phase: 'resolved',
      exceptionId: 'incident',
      proposalId: 'proposal',
    });
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      await handle.fetchHistory(),
    );
  });
  expect(activities.execute).toHaveBeenCalledTimes(1);
  expect(activities.verify).toHaveBeenCalledTimes(1);
}, 30_000);

it('resumes approval after worker replacement; notifications carry no authorization', async () => {
  const activities = fixture();
  let approved = false;
  activities.execute.mockImplementation(async () =>
    approved
      ? { state: 'succeeded' }
      : { state: 'approval_required', decisionId: 'decision' },
  );
  const taskQueue = randomUUID();
  const handle = await env.client.workflow.start('exceptionWorkflow', {
    workflowId: randomUUID(),
    taskQueue,
    args: [input],
  });
  const first = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await first.runUntil(async () => {
    await vi.waitFor(
      async () =>
        expect(await handle.query<WorkflowProgress>('progress')).toMatchObject({
          phase: 'awaiting_approval',
        }),
      { timeout: 10_000 },
    );
    await handle.signal('approvalChanged');
    await vi.waitFor(
      () => expect(activities.execute).toHaveBeenCalledTimes(2),
      { timeout: 10_000 },
    );
    expect(activities.verify).not.toHaveBeenCalled();
  });
  approved = true;
  await handle.signal('approvalChanged');
  const second = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await second.runUntil(async () =>
    expect(await handle.result()).toMatchObject({ phase: 'resolved' }),
  );
  expect(activities.detect).toHaveBeenCalledTimes(1);
  expect(activities.propose).toHaveBeenCalledTimes(1);
}, 30_000);

it.each(['reconciliation_required', 'failed', 'denied'] as const)(
  'handles execution %s without redispatch',
  async (state) => {
    const activities = fixture();
    activities.execute.mockResolvedValue({ state });
    activities.reconcile.mockResolvedValue({
      state: 'reconciliation_required',
    });
    expect(await run(activities)).toMatchObject({
      phase: state === 'denied' ? 'denied' : 'escalated',
    });
    expect(activities.execute).toHaveBeenCalledTimes(1);
    expect(activities.reconcile).toHaveBeenCalledTimes(
      state === 'reconciliation_required' ? 1 : 0,
    );
    expect(activities.verify).not.toHaveBeenCalled();
  },
  15_000,
);

it('recovers a lost activity result through read-only reconciliation', async () => {
  const activities = fixture();
  activities.execute.mockRejectedValue(
    ApplicationFailure.nonRetryable('lost completion'),
  );
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.execute).toHaveBeenCalledTimes(1);
  expect(activities.reconcile).toHaveBeenCalledTimes(1);
}, 15_000);

it('does not turn failed business verification into resolution', async () => {
  const activities = fixture();
  activities.verify.mockResolvedValue(false);
  expect(await run(activities)).toMatchObject({
    phase: 'escalated',
    reason: 'verification_requires_review',
  });
}, 15_000);

it('expires approval without dispatching again', async () => {
  const activities = fixture();
  activities.propose.mockImplementation(async () => ({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  }));
  activities.execute.mockResolvedValue({
    state: 'approval_required',
    decisionId: 'decision',
  });
  expect(await run(activities)).toMatchObject({
    phase: 'denied',
    reason: 'proposal_expired',
  });
  expect(activities.execute).toHaveBeenCalledTimes(1);
}, 15_000);

it('leaves unsupported proposals for manual intervention', async () => {
  const activities = fixture();
  activities.propose.mockResolvedValue(null);
  expect(await run(activities)).toMatchObject({
    phase: 'escalated',
    reason: 'manual_intervention_required',
  });
  expect(activities.execute).not.toHaveBeenCalled();
}, 15_000);

it('stops when detection finds no incident', async () => {
  const activities = fixture();
  activities.detect.mockResolvedValue(null);
  expect(await run(activities)).toEqual({ phase: 'no_incident' });
  expect(activities.diagnose).not.toHaveBeenCalled();
}, 15_000);

it('routes a detector clear result through fresh business verification', async () => {
  const activities = fixture();
  activities.diagnose.mockResolvedValue({
    status: 'ready',
    revision: 1,
    verificationRequired: true,
    retryAfter: null,
  });
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.propose).not.toHaveBeenCalled();
  expect(activities.execute).not.toHaveBeenCalled();
  expect(activities.verify).toHaveBeenCalledTimes(1);
}, 15_000);

it('honors diagnosis backoff and evaluates the next revision', async () => {
  const activities = fixture();
  activities.diagnose.mockResolvedValueOnce({
    status: 'pending',
    revision: 1,
    verificationRequired: false,
    retryAfter: new Date(Date.now() + 1000).toISOString(),
  });
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.diagnose).toHaveBeenCalledTimes(2);
}, 15_000);

it('recovers committed approval without a notification', async (t) => {
  const clock = await TestWorkflowEnvironment.createTimeSkipping();
  t.onTestFinished(() => clock.teardown());
  const activities = fixture();
  activities.propose.mockResolvedValue({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date((await clock.currentTimeMs()) + 60_000).toISOString(),
  });
  activities.execute.mockResolvedValueOnce({
    state: 'approval_required',
    decisionId: 'decision',
  });
  expect(await run(activities, clock)).toMatchObject({ phase: 'resolved' });
  expect(activities.execute).toHaveBeenCalledTimes(2);
}, 40_000);

it.each(['succeeded', 'reconciliation_required', 'lost_completion'] as const)(
  'waits for in-flight execution before cancellation recovery: %s',
  async (outcome) => {
    const activities = fixture();
    let entered!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let committed = false;
    activities.execute.mockImplementation(async () => {
      entered();
      await pending;
      committed = true;
      if (outcome === 'lost_completion')
        throw ApplicationFailure.nonRetryable(
          'completion lost after provider commit',
        );

      return { state: outcome };
    });
    activities.reconcile.mockImplementation(async () => {
      expect(committed).toBe(true);

      return { state: 'succeeded' };
    });
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: bundle,
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('exceptionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [input],
      });
      try {
        await executing;
        await handle.cancel();
        // Wait until a workflow task has processed cancellation, not merely until the request was accepted.
        await vi.waitFor(
          async () => {
            const events = (await handle.fetchHistory()).events ?? [];
            const cancelIndex = events.findIndex(
              (event) => event.workflowExecutionCancelRequestedEventAttributes,
            );
            expect(cancelIndex).toBeGreaterThanOrEqual(0);
            expect(
              events
                .slice(cancelIndex + 1)
                .some((event) => event.workflowTaskCompletedEventAttributes),
            ).toBe(true);
          },
          { timeout: 10_000 },
        );
        expect(activities.reconcile).not.toHaveBeenCalled();
        expect((await handle.describe()).status.name).toBe('RUNNING');
        finish();
        await expect(handle.result()).rejects.toThrow();
        expect((await handle.describe()).status.name).toBe('CANCELLED');
        expect(activities.reconcile).toHaveBeenCalledTimes(1);
        expect(activities.execute).toHaveBeenCalledTimes(1);
        expect(activities.verify).not.toHaveBeenCalled();
        await Worker.runReplayHistory(
          { workflowBundle: bundle },
          await handle.fetchHistory(),
        );
      } finally {
        finish();
      }
    });
  },
  15_000,
);

it.each([
  {
    error: new TypeError('private activity failure', {
      cause: new Error('private provider failure'),
    }),
    nonRetryable: false,
  },
  {
    error: new IdentityError(503, 'SERVICE_UNAVAILABLE', 'private outage'),
    nonRetryable: false,
  },
  {
    error: new IdentityError(403, 'FORBIDDEN', 'private authorization details'),
    nonRetryable: true,
  },
  {
    error: new WorkflowInputError('private invalid input'),
    nonRetryable: true,
  },
  { error: 'private thrown value', nonRetryable: false },
])(
  'logs the original failure and sanitizes Temporal history: $error',
  async ({ error, nonRetryable }) => {
    const writeLog = vi.fn();
    const captureActivityError = vi.fn();
    const environment = new MockActivityEnvironment(
      {
        workflowExecution: { workflowId: 'workflow', runId: 'run' },
        activityId: '443',
        activityType: 'refresh',
        attempt: 5,
        taskQueue: 'queue',
      },
      { logger: new DefaultLogger('WARN', writeLog) },
    );
    const activities = temporalActivities(
      { ...fixture(), refresh: vi.fn().mockRejectedValue(error) },
      captureActivityError,
    );
    const failure = await environment
      .run(activities.refresh!, input, 'incident')
      .catch((failure: unknown) => failure);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      message: nonRetryable
        ? 'Workflow authorization or input rejected'
        : 'Workflow activity unavailable',
      type: nonRetryable ? 'WorkflowRejected' : 'WorkflowActivityUnavailable',
      nonRetryable,
      cause: undefined,
      details: [],
    });
    // Matches the private messages above, not paths such as macOS /private/tmp checkouts.
    expect((failure as Error).stack).not.toMatch(/private [a-z]/);
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'ERROR',
        message: 'Workflow activity failed before sanitization',
        meta: expect.objectContaining({
          error,
          workflowId: 'workflow',
          workflowRunId: 'run',
          activityId: '443',
          activityType: 'refresh',
          attempt: 5,
          taskQueue: 'queue',
        }),
      }),
    );
    const entry = writeLog.mock.calls.find(
      ([entry]) => entry.level === 'ERROR',
    )![0];
    expect(entry.meta.error).toBe(error);
    expect(entry.meta).not.toHaveProperty('args');
    expect(captureActivityError).toHaveBeenCalledExactlyOnceWith(error, {
      workflowId: 'workflow',
      workflowRunId: 'run',
      activityId: '443',
      activityType: 'refresh',
      attempt: 5,
      taskQueue: 'queue',
      namespace: 'test',
    });
  },
);

it.each([
  ['workspace', new WorkspaceInactiveError(), 'WorkspaceInactive'],
  ['acting member', new MembershipSuspendedError(), 'MembershipSuspended'],
  [
    'acting member (account disabled)',
    new AccountDisabledError(),
    'MembershipSuspended',
  ],
])(
  'reports a suspended %s to the workflow without logging a failure',
  async (_name, error, type) => {
    const writeLog = vi.fn();
    const captureActivityError = vi.fn();
    const environment = new MockActivityEnvironment(
      { workflowExecution: { workflowId: 'workflow', runId: 'run' } },
      { logger: new DefaultLogger('WARN', writeLog) },
    );
    const activities = fixture();
    activities.detect.mockRejectedValue(error);
    const wrapped = temporalActivities(activities, captureActivityError);

    await expect(environment.run(wrapped.detect, input)).rejects.toMatchObject({
      type,
      nonRetryable: true,
      cause: undefined,
    });
    expect(writeLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: 'ERROR' }),
    );
    expect(captureActivityError).not.toHaveBeenCalled();
  },
);

it('pauses while the workspace is suspended and continues after reactivation', async (t) => {
  const clock = await TestWorkflowEnvironment.createTimeSkipping();
  t.onTestFinished(() => clock.teardown());
  const now = await clock.currentTimeMs();
  const suspended = ApplicationFailure.nonRetryable(
    'Workspace is not active',
    'WorkspaceInactive',
  );
  const activities = fixture();
  activities.propose.mockResolvedValue({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(now + 86_400_000).toISOString(),
  });
  activities.diagnose
    .mockRejectedValueOnce(suspended)
    .mockRejectedValueOnce(suspended);
  activities.execute.mockRejectedValueOnce(suspended);
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: clock.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await worker.runUntil(async () => {
    const handle = await clock.client.workflow.start('exceptionWorkflow', {
      workflowId: randomUUID(),
      taskQueue,
      args: [input],
    });
    expect(await handle.result()).toMatchObject({ phase: 'resolved' });
    const timers = (await handle.fetchHistory()).events!.filter(
      (event) => event.timerStartedEventAttributes,
    );
    // Rechecks wait one minute, then twice as long, and restart after the workspace resumes.
    expect(
      timers.map((event) =>
        String(event.timerStartedEventAttributes!.startToFireTimeout!.seconds),
      ),
    ).toEqual(['60', '120', '60']);
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      await handle.fetchHistory(),
    );
  });
  expect(activities.diagnose).toHaveBeenCalledTimes(3);
  // The rejected attempt ran no effect; the action runs once the workspace is active again.
  expect(activities.execute).toHaveBeenCalledTimes(2);
  expect(activities.reconcile).not.toHaveBeenCalled();
  expect(activities.verify).toHaveBeenCalledTimes(1);
}, 40_000);

it('preserves the activity failure when error reporting fails', async () => {
  const environment = new MockActivityEnvironment(
    {},
    {
      logger: new DefaultLogger('WARN', vi.fn()),
    },
  );
  const activities = fixture();
  activities.detect.mockRejectedValue(new Error('original failure'));
  const wrapped = temporalActivities(activities, () => {
    throw new Error('reporter failure');
  });

  await expect(environment.run(wrapped.detect, input)).rejects.toMatchObject({
    type: 'WorkflowActivityUnavailable',
    nonRetryable: false,
    cause: undefined,
  });
});

it('refreshes expired evidence without ending the human approval wait', async () => {
  const activities = {
    ...fixture(),
    refresh: vi.fn().mockResolvedValue({
      id: 'renewed',
      revision: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshable: true,
    }),
  };
  activities.propose.mockResolvedValue({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshable: true,
  });
  expect(await run(activities)).toMatchObject({
    phase: 'resolved',
    proposalId: 'renewed',
  });
  expect(activities.refresh).toHaveBeenCalledTimes(1);
  expect(activities.execute).toHaveBeenCalledWith(
    input,
    'incident',
    expect.objectContaining({ id: 'renewed', revision: 2 }),
  );
}, 15_000);

it('switches to a refreshed immutable proposal before dispatch and reconciliation', async () => {
  const activities = fixture();
  activities.execute.mockResolvedValueOnce({
    state: 'proposal_changed',
    proposal: {
      id: 'renewed',
      revision: 2,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  expect(await run(activities)).toMatchObject({
    phase: 'resolved',
    proposalId: 'renewed',
  });
  expect(activities.execute).toHaveBeenLastCalledWith(
    input,
    'incident',
    expect.objectContaining({ id: 'renewed' }),
  );
  expect(activities.reconcile).not.toHaveBeenCalled();
}, 15_000);

it('recovers a temporary refresh failure without asking for another decision or dispatching early', async (t) => {
  const clock = await TestWorkflowEnvironment.createTimeSkipping();
  t.onTestFinished(() => clock.teardown());
  const now = await clock.currentTimeMs();
  const activities = {
    ...fixture(),
    refresh: vi
      .fn()
      .mockRejectedValueOnce(
        ApplicationFailure.nonRetryable(
          'Read temporarily unavailable',
          'WorkflowActivityUnavailable',
        ),
      )
      .mockResolvedValue({
        id: 'renewed',
        revision: 2,
        expiresAt: new Date(now + 120_000).toISOString(),
        refreshable: true,
      }),
  };
  activities.propose.mockResolvedValue({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(now - 1000).toISOString(),
    refreshable: true,
  });
  expect(await run(activities, clock)).toMatchObject({
    phase: 'resolved',
    proposalId: 'renewed',
  });
  expect(activities.refresh).toHaveBeenCalledTimes(2);
  expect(activities.execute).toHaveBeenCalledTimes(1);
}, 40_000);

it('stops refreshing after workflow authorization is revoked', async () => {
  const activities = {
    ...fixture(),
    refresh: vi
      .fn()
      .mockRejectedValue(
        ApplicationFailure.nonRetryable(
          'Authorization changed',
          'WorkflowRejected',
        ),
      ),
  };
  activities.propose.mockResolvedValue({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshable: true,
  });
  expect(await run(activities)).toMatchObject({
    phase: 'escalated',
    reason: 'activity_failed',
  });
  expect(activities.refresh).toHaveBeenCalledTimes(1);
  expect(activities.execute).not.toHaveBeenCalled();
}, 15_000);

it.each(['ready', 'missing', 'insufficient', 'clear'] as const)(
  'completes Shadow %s evaluation without dispatch, reconciliation or live verification',
  async (state) => {
    const activities = {
      ...fixture(),
      shadow: vi.fn().mockResolvedValue(undefined),
    };
    if (state === 'missing') activities.propose.mockResolvedValue(null);
    if (state === 'insufficient')
      activities.diagnose.mockResolvedValue({
        status: 'insufficient_evidence',
        revision: 1,
        verificationRequired: false,
        retryAfter: null,
      });
    if (state === 'clear')
      activities.diagnose.mockResolvedValue({
        status: 'ready',
        revision: 1,
        verificationRequired: true,
        retryAfter: null,
      });
    const shadow = { id: randomUUID(), workflow: 'shipping-method-correction' };
    expect(await run(activities, env, { ...input, shadow })).toMatchObject({
      phase: 'shadow_completed',
      reason: 'simulation_only',
    });
    expect(activities.propose).not.toHaveBeenCalled();
    expect(activities.shadow).toHaveBeenCalledWith(
      { ...input, shadow },
      'incident',
    );
    expect(activities.execute).not.toHaveBeenCalled();
    expect(activities.reconcile).not.toHaveBeenCalled();
    expect(activities.verify).not.toHaveBeenCalled();
  },
);

it('created AU clients and workers write encrypted history and reject foreign envelopes', async () => {
  const keyArn =
    'arn:aws:kms:ap-southeast-2:123456789012:key/11111111-1111-1111-1111-111111111111';
  const encryption: TemporalPayloadEncryption = {
    keyArn,
    kmsRegion: 'ap-southeast-2',
    decryptionKeyArns: [],
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    cacheTtlMs: 1000,
    cacheMaxUses: 100,
  };
  const wrappedKeys = new Map<string, Buffer>();
  const keys = {
    async generate() {
      const plaintext = randomBytes(32);
      const wrappedKey = randomBytes(48);
      wrappedKeys.set(wrappedKey.toString('base64'), Buffer.from(plaintext));

      return { plaintext, wrappedKey };
    },
    async decrypt(_keyArn: string, wrappedKey: Uint8Array) {
      const key = wrappedKeys.get(Buffer.from(wrappedKey).toString('base64'));
      if (!key) throw new Error('Temporal encryption key unavailable');

      return Buffer.from(key);
    },
  };
  const settings = {
    address: env.address,
    namespace: 'default',
    taskQueue: randomUUID(),
    dataRegion: 'AU' as const,
    payloadEncryption: encryption,
    payloadKeyService: keys,
  };
  const activities = fixture();
  activities.diagnose.mockRejectedValueOnce(
    new Error('private-upstream-error'),
  );
  const worker = await createExceptionWorker(settings, activities);
  const tenantId = randomUUID();
  const scoped = makeTenantContext(
    { userId: 'private-user', sessionId: 'synthetic-session' },
    {
      id: tenantId,
      name: 'Synthetic',
      slug: 'synthetic',
      status: 'active',
      dataRegion: 'AU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId: 'private-user' },
      'owner',
    ),
    'private-request',
  );
  const client = await createExceptionClient(settings, {
    refreshContext: async (value) => value,
  });
  const running = worker.run();
  const replay = temporalDataConverter(settings);
  try {
    const source = { kind: 'incident' as const, id: 'private-source' };
    const started = await client.start(scoped, source);
    await vi.waitFor(
      async () =>
        expect(await client.progress(scoped, source)).toMatchObject({
          phase: 'resolved',
        }),
      { timeout: 10000 },
    );
    const history = await env.client.workflow
      .getHandle(started.workflowId)
      .fetchHistory();
    let payloadCount = 0;

    function inspect(value: unknown, path = 'history') {
      if (!value || typeof value !== 'object' || value instanceof Uint8Array)
        return;
      if (
        'metadata' in value &&
        value.metadata &&
        typeof value.metadata === 'object' &&
        'encoding' in value.metadata
      ) {
        if (
          path.endsWith(
            '.upsertWorkflowSearchAttributesEventAttributes.searchAttributes.indexedFields.TemporalChangeVersion',
          )
        ) {
          expect(
            'data' in value
              ? JSON.parse(Buffer.from(value.data as Uint8Array).toString())
              : null,
          ).toEqual(['automatic-proposal-refresh-v1']);

          return;
        }
        if (
          path.endsWith(
            '.markerRecordedEventAttributes.details.patch-data.payloads.0',
          )
        ) {
          expect(
            'data' in value
              ? JSON.parse(Buffer.from(value.data as Uint8Array).toString())
              : null,
          ).toEqual({ id: 'automatic-proposal-refresh-v1', deprecated: false });

          return;
        }
        const encoding = value.metadata.encoding;
        expect(encoding).toBeInstanceOf(Uint8Array);
        expect(
          Buffer.from(encoding as Uint8Array).toString(),
          `${path}: ${'data' in value ? Buffer.from(value.data as Uint8Array).toString() : ''}`,
        ).toBe('binary/luma-kms-v1');
        payloadCount += 1;
      }
      for (const [key, child] of Object.entries(value))
        inspect(child, `${path}.${key}`);
    }

    inspect(history);
    expect(payloadCount).toBeGreaterThan(5);
    const raw = JSON.stringify(history);
    expect(raw).not.toContain('private-user');
    expect(raw).not.toContain('private-request');
    expect(raw).not.toContain('private-source');
    expect(raw).not.toContain('private-upstream-error');
    expect(raw).not.toContain(scoped.tenantId);
    await Worker.runReplayHistory(
      { workflowBundle: bundle, dataConverter: replay.converter },
      history,
    );
    expect(activities.execute).toHaveBeenCalledOnce();

    const unavailable = vi.fn(async () => {
      throw new Error('Temporal encryption key unavailable');
    });
    const noAccess = temporalDataConverter({
      ...settings,
      payloadKeyService: {
        ...keys,
        decrypt: unavailable,
      },
    });
    try {
      await expect(
        Worker.runReplayHistory(
          { workflowBundle: bundle, dataConverter: noAccess.converter },
          history,
        ),
      ).rejects.toThrow();
      expect(unavailable).toHaveBeenCalled();
      expect(activities.execute).toHaveBeenCalledOnce();
    } finally {
      noAccess.close();
    }
    await expect(
      client.start({ ...scoped, dataRegion: 'EU' }, source),
    ).rejects.toThrow('region rejected');
  } finally {
    worker.shutdown();
    await running;
    await client.close();
    await worker.close();
    replay.close();
  }
}, 30000);
