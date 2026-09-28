import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@luma/identity';
import { IdentityError, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  createDraftTests,
  type DraftTestStore,
  type SavedDraftTests,
  type StoredDraftTestRun,
} from '../application/draft-tests.js';
import { runProcess } from '../application/process-runtime.js';
import {
  CodeRequestStopped,
  type CodeRunner,
  type CodeTelemetry,
} from '../domain/code-step.js';
import type { WorkflowDraft, WorkflowDraftContent } from '../domain/draft.js';
import { defaultCase, type DraftTestCase } from '../domain/draft-test.js';
import { processSource } from '../domain/process.fixture.js';
import type { ProcessStepOutput } from '../domain/process.js';
import { mergeVocabulary } from '../domain/vocabulary.js';
import type { WorkflowRun } from '../domain/workflow.js';
import { createWasmtimeRunner } from './code/runner.js';
import { playbookHash } from './playbooks/schema.js';
import { checkDraftContent } from './process-schema.js';

vi.mock('../application/process-runtime.js', { spy: true });

const tenantId = 'tenant';
const runtimeDirectory =
  process.env.LUMA_CODE_RUNTIME_DIR ??
  fileURLToPath(new URL('../../../../.luma/code-runtime/', import.meta.url));
const clockStart = '2026-01-01T00:00:00.000Z';

function context(
  role: 'owner' | 'admin' | 'member',
  userId = `${role}-id`,
  tenant = tenantId,
) {
  return makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenant,
      name: 'Tenant',
      slug: tenant,
      dataRegion: 'EU',
      status: 'active',
    },
    { id: `membership-${userId}`, organizationId: tenant, userId, role },
    'request',
  );
}

/** Copies a record without the named keys. */
function omit<T extends object>(record: T, ...keys: string[]): T {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  ) as T;
}

const source = omit(processSource, 'provenance');
const content: WorkflowDraftContent = {
  ...source,
  definition: { ...source.definition, id: 'restock' },
};

const limits = {
  fuel: 100_000_000,
  memoryBytes: 67_108_864,
  wallTimeMs: 5000,
  maxRequests: 2,
};

const codeContent: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: {
    id: 'code-restock',
    name: 'Code restock',
    intent: 'Compute and reserve an order quantity.',
    category: 'custom',
  },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  inputs: { target: 'number' },
  context: { kind: 'manual', fields: {}, maxAgeSeconds: 300 },
  steps: [
    {
      id: 'calculate',
      kind: 'code',
      source:
        'function main(input, luma) { const stock = luma.request("stock"); luma.request("order"); return { quantity: Math.max(0, input.inputs.target - stock.available) }; }',
      fields: { quantity: 'number' },
      grants: ['stock', 'order'],
      limits,
    },
    {
      id: 'stock',
      kind: 'read',
      source: 'inventory',
      fields: { available: 'number' },
    },
    {
      id: 'order',
      kind: 'capability',
      capability: 'stock.reserve',
      capabilityVersion: '1',
      targetKind: 'order',
      minimumRisk: 'medium',
      parameters: {
        quantity: { source: 'step', stepId: 'stock', field: 'available' },
      },
      expectedPostcondition: {
        reserved: { source: 'literal', value: true },
      },
    },
    {
      id: 'order-check',
      kind: 'verification',
      forStep: 'order',
      evaluatorVersion: '1',
      maxDurationSeconds: 60,
      fields: { reserved: 'boolean' },
    },
    { id: 'finish', kind: 'end', outcome: 'Computed' },
  ],
};

const vocabulary = mergeVocabulary(
  [
    {
      reads: [
        {
          source: 'inventory',
          label: 'Current stock',
          description: '',
          fields: { ready: 'boolean', available: 'number' },
          executable: false,
          reason: 'Not installed',
        },
      ],
      capabilities: [
        {
          capability: 'stock.reserve',
          version: '1',
          label: 'Reserve stock',
          description: '',
          targetKind: 'order',
          minimumRisk: 'medium',
          approval: '',
          parameters: { quantity: 'number' },
          postcondition: { reserved: 'boolean' },
          evaluators: ['1'],
          executable: false,
          reason: 'Not installed',
        },
      ],
      evaluators: [
        {
          version: '1',
          label: 'Check the reservation',
          description: '',
          fields: { reserved: 'boolean' },
          executable: false,
          reason: 'Not installed',
        },
      ],
    },
  ],
  { runtime: 'test', limits },
);

function memoryStore(now: () => Date) {
  const saved = new Map<string, SavedDraftTests>();
  const runs = new Map<
    string,
    { item: StoredDraftTestRun; principal: string; draftId: string }
  >();
  const key = (c: TenantContext, id: string) => `${c.tenantId}:${id}`;
  const store: DraftTestStore = {
    cases: async (c, draftId) =>
      structuredClone(saved.get(key(c, draftId)) ?? { revision: 0, cases: [] }),
    saveCases: async (c, draftId, revision, cases) => {
      const current = saved.get(key(c, draftId)) ?? { revision: 0, cases: [] };
      if (current.revision !== revision) return null;
      const next = { revision: revision + 1, cases: structuredClone(cases) };
      saved.set(key(c, draftId), next);

      return structuredClone(next);
    },
    get: async (c, draftId, id) => {
      const row = runs.get(key(c, id));

      return row && row.principal === c.actor.id && row.draftId === draftId
        ? structuredClone(row.item)
        : null;
    },
    runs: async (c, draftId, revision) =>
      [...runs.entries()]
        .filter(
          ([k, row]) =>
            k.startsWith(`${c.tenantId}:`) &&
            row.draftId === draftId &&
            row.item.revision === revision &&
            row.item.caseId,
        )
        .map(([, row]) => structuredClone(row.item))
        .reverse(),
    reserve: async (c, draftId, item) => {
      const row = runs.get(key(c, item.id));
      if (row) {
        if (
          row.item.requestDigest !== item.requestDigest ||
          row.principal !== c.actor.id ||
          row.draftId !== draftId
        )
          throw new IdentityError(409, 'CONFLICT', 'Different inputs.');

        return { item: structuredClone(row.item), created: false };
      }
      runs.set(key(c, item.id), {
        item: structuredClone(item),
        principal: c.actor.id,
        draftId,
      });

      return { item, created: true };
    },
    finish: async (c, _draftId, item) => {
      const row = runs.get(key(c, item.id));
      if (
        row?.item.state === 'running' &&
        Date.parse(row.item.expiresAt) > now().getTime()
      )
        row.item = structuredClone(item);
    },
    cancel: async (c, _draftId, id) => {
      const row = runs.get(key(c, id));
      if (row?.item.state === 'running') row.item.state = 'cancelled';
    },
  };

  return { store, runs, saved };
}

function setup(
  options: {
    runner?: CodeRunner;
    recent?: { run: WorkflowRun; steps: ProcessStepOutput[] }[];
    refresh?: (c: TenantContext) => Promise<TenantContext>;
  } = {},
) {
  let time = new Date('2026-09-28T10:00:00Z');
  const now = () => time;
  const memory = memoryStore(now);
  const drafts = new Map<string, WorkflowDraft>();
  const draft = (
    body: WorkflowDraftContent,
    extra: Partial<WorkflowDraft> = {},
  ) => {
    const item: WorkflowDraft = {
      id: randomUUID(),
      tenantId,
      revision: 1,
      state: 'draft',
      mode: 'visual',
      content: structuredClone(body),
      codeView: null,
      basedOn: null,
      authorId: 'owner-id',
      updatedBy: 'owner-id',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
      published: null,
      ...extra,
    };
    drafts.set(`${tenantId}:${item.id}`, item);

    return item;
  };
  const recentRuns = vi.fn(async () => options.recent ?? []);
  const scenarios = vi.fn(() => [
    {
      id: 'happy',
      name: 'Happy path',
      description: 'Everything works.',
      case: defaultCase(content, randomUUID(), 'Happy path'),
    },
  ]);
  const deps = {
    drafts: {
      get: async (c: TenantContext, id: string) =>
        structuredClone(drafts.get(`${c.tenantId}:${id}`) ?? null),
    },
    check: checkDraftContent,
    store: memory.store,
    ...(options.runner ? { runner: options.runner } : {}),
    vocabulary: async () => vocabulary,
    recentRuns,
    scenarioSources: [{ scenarios }],
    refreshContext: options.refresh ?? (async (item: TenantContext) => item),
    hash: playbookHash,
    id: randomUUID,
    now,
    clockStart,
  };
  const service = createDraftTests(deps);

  async function settle(c: TenantContext, draftId: string, id: string) {
    await vi.waitFor(
      async () => {
        const run = await service.get(c, draftId, id);
        if (run.state === 'running') throw new Error('still running');
      },
      { timeout: 3000, interval: 5 },
    );

    return service.get(c, draftId, id);
  }

  async function run(
    c: TenantContext,
    item: WorkflowDraft,
    testCase: DraftTestCase,
  ) {
    const started = await service.start(c, item.id, {
      id: randomUUID(),
      revision: item.revision,
      case: testCase,
    });

    return settle(c, item.id, started.id);
  }

  return {
    service,
    deps,
    draft,
    drafts,
    memory,
    recentRuns,
    scenarios,
    settle,
    run,
    advance(ms: number) {
      time = new Date(time.getTime() + ms);
    },
  };
}

const owner = context('owner');
const example = (overrides: Partial<DraftTestCase> = {}): DraftTestCase => ({
  ...defaultCase(content, randomUUID()),
  inputs: { quantity: 2 },
  evidence: { ready: true },
  replies: {
    refresh: { kind: 'read', values: { ready: true } },
    review: { kind: 'approval', decision: 'approved' },
    reserve: { kind: 'capability', result: 'accepted' },
    verify: {
      kind: 'verification',
      state: 'verified',
      values: { reserved: true },
    },
  },
  ...overrides,
});

describe('draft test runs', () => {
  it('uses the production interpreter with example replies and no admission or connector port', async () => {
    const f = setup();
    const item = f.draft(content);
    vi.mocked(runProcess).mockClear();
    const run = await f.run(owner, item, {
      ...example(),
      expected: { outcome: 'verified' },
    });

    expect(run.state).toBe('completed');
    expect(run.result).toMatchObject({
      outcome: 'verified',
      stoppedAt: 'finish',
      passed: true,
    });
    expect(
      run.result!.steps.map((step) => [step.stepId, step.state, step.branch]),
    ).toEqual([
      ['refresh', 'completed', 'continued'],
      ['eligible', 'completed', 'continued'],
      ['review', 'completed', 'continued'],
      ['reserve', 'completed', 'continued'],
      ['verify', 'completed', 'continued'],
      ['settle', 'completed', 'continued'],
      ['finish', 'completed', 'ended'],
    ]);
    const steps = Object.fromEntries(
      run.result!.steps.map((step) => [step.stepId, step]),
    );
    expect(steps.refresh!.note).toBe(
      'Current stock in this example: ready is yes.',
    );
    expect(steps.eligible).toMatchObject({
      inputs: { ready: true },
      note: 'ready is yes, so the workflow continued.',
    });
    expect(steps.reserve).toMatchObject({
      title: 'Take an action',
      inputs: { quantity: 2 },
      note: 'Action Admission would check “Reserve stock” against policy before it runs. In this example it was accepted.',
    });
    expect(steps.verify).toMatchObject({
      inputs: { reserved: true },
      note: 'Check the reservation confirmed the result in this example: reserved is yes.',
    });
    expect(steps.settle!.note).toBe(
      'Would wait 5 second(s). The test skips the wait.',
    );

    // The real interpreter ran once, bound to the compiled draft and a fixed clock.
    expect(runProcess).toHaveBeenCalledOnce();
    const [boundRun, version, activities, clock] =
      vi.mocked(runProcess).mock.calls[0]!;
    expect(boundRun).toMatchObject({
      id: run.id,
      tenantId,
      definitionId: 'restock',
      subject: { kind: 'order', id: 'example' },
      actor: { kind: 'user', id: 'owner-id' },
      createdAt: clockStart,
    });
    expect(version.digest).toBe(boundRun.versionDigest);
    expect(Object.keys(activities).sort()).toEqual([
      'action',
      'code',
      'decision',
      'read',
      'record',
      'verify',
    ]);
    expect(clock.now()).toBe('2026-01-01T00:00:05.000Z');
    expect(Object.keys(f.deps).sort()).toEqual(
      [
        'check',
        'clockStart',
        'drafts',
        'hash',
        'id',
        'now',
        'recentRuns',
        'refreshContext',
        'scenarioSources',
        'store',
        'vocabulary',
      ].sort(),
    );
    expect(f.recentRuns).not.toHaveBeenCalled();

    // The service cannot reach Action Admission, effects, connectors or production activities.
    const module = await readFile(
      new URL('../application/draft-tests.ts', import.meta.url),
      'utf8',
    );
    const imports = module.match(/^import[\s\S]*?from '([^']+)';$/gm) ?? [];
    expect(imports.join('\n')).not.toMatch(
      /@luma\/(execution|connections|policies|procurement)|process-activities|code-activity|temporal/,
    );
  });

  it('shows where a person would decide and which branch the workflow took', async () => {
    const f = setup();
    const item = f.draft(content);
    const pending = await f.run(owner, item, {
      ...example({ expected: { outcome: 'awaiting_decision' } }),
      replies: {
        ...example().replies,
        review: { kind: 'approval', decision: 'pending' },
      },
    });
    expect(pending.result).toMatchObject({
      outcome: 'awaiting_decision',
      stoppedAt: 'review',
      passed: true,
      reason: 'The workflow would wait here for an owner or admin to decide.',
    });
    expect(pending.result!.steps.at(-1)).toMatchObject({
      stepId: 'review',
      state: 'waiting',
      branch: 'paused',
      note: 'Would wait here for an owner or admin to approve.',
    });

    const withoutApproval = omit(example().replies, 'review');
    expect(
      (await f.run(owner, item, { ...example(), replies: withoutApproval }))
        .result?.outcome,
    ).toBe('awaiting_decision');

    const approvalRequired = await f.run(owner, item, {
      ...example(),
      replies: {
        ...example().replies,
        reserve: { kind: 'capability', result: 'approval_required' },
      },
    });
    expect(approvalRequired.result).toMatchObject({
      outcome: 'awaiting_decision',
      stoppedAt: 'reserve',
    });
    expect(approvalRequired.result!.steps.at(-1)!.branch).toBe('paused');

    const denied = await f.run(owner, item, {
      ...example({ expected: { outcome: 'verified' } }),
      replies: {
        ...example().replies,
        reserve: { kind: 'capability', result: 'denied' },
      },
    });
    expect(denied.result).toMatchObject({
      outcome: 'escalated',
      stoppedAt: 'reserve',
      passed: false,
    });
    expect(denied.result!.steps.at(-1)).toMatchObject({
      state: 'escalated',
      branch: 'escalated',
      note: 'Action Admission would check “Reserve stock” against policy before it runs. In this example it was denied, so the workflow escalated to a person.',
    });

    const rejected = await f.run(owner, item, {
      ...example(),
      replies: {
        ...example().replies,
        review: { kind: 'approval', decision: 'denied' },
      },
    });
    expect(rejected.result).toMatchObject({ outcome: 'denied' });
    expect(rejected.result!.steps.at(-1)!.branch).toBe('denied');

    const notReady = await f.run(owner, item, {
      ...example(),
      replies: {
        ...example().replies,
        refresh: { kind: 'read', values: { ready: false } },
      },
    });
    expect(notReady.result).toMatchObject({
      outcome: 'escalated',
      stoppedAt: 'eligible',
    });
    expect(notReady.result!.steps.at(-1)!.note).toBe(
      'ready is no, not yes, so the workflow escalated to a person.',
    );

    const failed = await f.run(owner, item, {
      ...example(),
      replies: {
        ...example().replies,
        verify: {
          kind: 'verification',
          state: 'failed',
          values: { reserved: false },
        },
      },
    });
    expect(failed.result).toMatchObject({
      outcome: 'failed_verification',
      stoppedAt: 'verify',
    });
    expect(failed.result!.steps.at(-1)!.branch).toBe('escalated');
  });

  it('is idempotent by run ID, rejects reused IDs and stale revisions', async () => {
    const f = setup();
    const item = f.draft(content);
    const body = { id: randomUUID(), revision: 1, case: example() };
    const first = await f.service.start(owner, item.id, body);
    await f.settle(owner, item.id, first.id);
    const retried = await f.service.start(owner, item.id, body);
    expect(retried.id).toBe(first.id);
    expect(retried.createdAt).toBe(first.createdAt);
    await expect(
      f.service.start(owner, item.id, {
        ...body,
        case: { ...body.case, name: 'Changed' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Another admin cannot reuse the ID and cannot read the first admin's run.
    const admin = context('admin');
    await expect(f.service.start(admin, item.id, body)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(f.service.get(admin, item.id, first.id)).rejects.toMatchObject(
      { statusCode: 404 },
    );

    // A retry after the draft changed still returns the original run.
    f.drafts.set(`${tenantId}:${item.id}`, { ...item, revision: 2 });
    expect((await f.service.start(owner, item.id, body)).id).toBe(first.id);
    await expect(
      f.service.start(owner, item.id, { ...body, id: randomUUID() }),
    ).rejects.toThrow('Reload the draft and run the test again.');

    const broken = f.draft({
      ...content,
      steps: [{ id: 'bad', kind: 'end', outcome: 'x' }],
    });
    await expect(
      f.service.start(owner, broken.id, { ...body, id: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.service.start(owner, item.id, {
        id: randomUUID(),
        revision: 2,
        case: { ...example(), inputs: {} },
      }),
    ).rejects.toThrow('Enter an example value for “quantity”.');
    await expect(
      f.service.start(owner, item.id, { id: randomUUID(), revision: 2 }),
    ).rejects.toThrow('Choose a saved test case or supply one.');
  });

  it('limits concurrent runs, cancels running code and reads abandoned runs as failed', async () => {
    const gates: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const telemetry = (outcome: CodeTelemetry['outcome']): CodeTelemetry => ({
      runtime: 'test',
      artifactDigest: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      wallTimeMs: 1,
      requests: 0,
      outcome,
    });
    const runner: CodeRunner = {
      run: (_step, _input, options) =>
        new Promise((resolve) => {
          signals.push(options.signal!);
          const done = () =>
            resolve({ values: {}, telemetry: telemetry('cancelled') });
          options.signal?.addEventListener('abort', done);
          gates.push(() =>
            resolve({
              values: { quantity: 1 },
              telemetry: telemetry('completed'),
            }),
          );
        }),
    };
    const f = setup({ runner });
    const item = f.draft({
      ...codeContent,
      steps: [
        {
          ...codeContent.steps[0]!,
          grants: [],
        } as WorkflowDraftContent['steps'][number],
        { id: 'finish', kind: 'end', outcome: 'Computed' },
      ],
    });
    const body = () => ({
      id: randomUUID(),
      revision: 1,
      case: {
        ...defaultCase(codeContent, randomUUID()),
        replies: {},
      },
    });
    const first = await f.service.start(owner, item.id, body());
    const second = await f.service.start(owner, item.id, body());
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(
      10_000,
    );
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await expect(f.service.start(owner, item.id, body())).rejects.toThrow(
      'The test runner is busy. Try again shortly.',
    );

    // Cancelling stops the sandbox through the polled state; a late result is not recorded.
    const cancelled = await f.service.cancel(owner, item.id, first.id);
    expect(cancelled.state).toBe('cancelled');
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true), {
      timeout: 2000,
    });
    gates[1]!();
    expect((await f.settle(owner, item.id, second.id)).result).toMatchObject({
      outcome: 'ended',
      steps: [
        expect.objectContaining({
          stepId: 'calculate',
          note: 'Computed quantity is 1 in the sandbox.',
        }),
        expect.objectContaining({ stepId: 'finish' }),
      ],
    });
    expect((await f.service.get(owner, item.id, first.id)).state).toBe(
      'cancelled',
    );
    await expect(
      f.service.cancel(context('member'), item.id, first.id),
    ).rejects.toMatchObject({ statusCode: 403 });

    // A run whose process stopped reads as failed after its deadline.
    const third = await f.service.start(owner, item.id, body());
    f.advance(11_000);
    expect(await f.service.get(owner, item.id, third.id)).toMatchObject({
      state: 'failed',
      error: 'The test run was interrupted. Run it again.',
    });
    gates[2]!();
  });

  it('runs Code Steps in the sandbox with example replies for granted reads and actions', async () => {
    const calls: { input: unknown; now: string; replies: unknown[] }[] = [];
    let outcome: CodeTelemetry['outcome'] = 'completed';
    const runner: CodeRunner = {
      async run(step, input, options) {
        const record = { input, now: options.now, replies: [] as unknown[] };
        calls.push(record);
        let requests = 0;
        const done = (
          result: CodeTelemetry['outcome'],
          values: Record<string, number> = {},
        ) => ({
          values,
          telemetry: {
            runtime: step.runtime,
            artifactDigest: step.artifactDigest,
            inputDigest: 'c'.repeat(64),
            wallTimeMs: 3,
            requests,
            outcome: result,
          },
        });
        if (outcome !== 'completed') return done(outcome);
        try {
          requests++;
          const stock = (await options.request('stock')) as {
            available: number;
          };
          record.replies.push(stock);
          requests++;
          record.replies.push(await options.request('order'));
          const target = (input as { inputs: { target: number } }).inputs
            .target;

          return done('completed', {
            quantity: Math.max(0, target - stock.available),
          });
        } catch (error) {
          if (error instanceof CodeRequestStopped) return done(error.outcome);
          throw error;
        }
      },
    };
    const f = setup({ runner });
    const item = f.draft(codeContent);
    const replies: DraftTestCase['replies'] = {
      stock: { kind: 'read', values: { available: 4 } },
      order: { kind: 'capability', result: 'accepted' },
      'order-check': {
        kind: 'verification',
        state: 'verified',
        values: { reserved: true },
      },
    };
    const testCase: DraftTestCase = {
      ...defaultCase(codeContent, randomUUID()),
      inputs: { target: 10 },
      replies,
      expected: { outcome: 'verified' },
    };
    const run = await f.run(owner, item, testCase);
    expect(calls[0]).toEqual({
      input: { inputs: { target: 10 }, evidence: {}, steps: {} },
      now: clockStart,
      replies: [{ available: 4 }, { reserved: true }],
    });
    expect(run.result).toMatchObject({ outcome: 'verified', passed: true });
    expect(
      run.result!.steps.map((step) => [
        step.stepId,
        step.state,
        step.branch,
        step.note,
      ]),
    ).toEqual([
      [
        'calculate',
        'completed',
        'continued',
        'Computed quantity is 6 in the sandbox.',
      ],
      [
        'stock',
        'completed',
        null,
        'Requested by the Code Step. Current stock in this example: available is 4.',
      ],
      [
        'order',
        'completed',
        null,
        'Requested by the Code Step. Action Admission would check “Reserve stock” against policy before it runs. In this example it was accepted.',
      ],
      [
        'order-check',
        'completed',
        null,
        'Requested by the Code Step. Check the reservation confirmed the result in this example: reserved is yes.',
      ],
      ['finish', 'completed', 'ended', 'Finishes with “Computed”.'],
    ]);
    expect(run.result!.steps[0]!.code).toMatchObject({
      outcome: 'completed',
      verifiedActions: 1,
    });
    expect(run.result!.steps[2]!.inputs).toEqual({ quantity: 4 });

    // An action that needs approval pauses the Code Step, like production.
    const waiting = await f.run(owner, item, {
      ...testCase,
      replies: {
        ...replies,
        order: { kind: 'capability', result: 'approval_required' },
      },
    });
    expect(waiting.result).toMatchObject({
      outcome: 'awaiting_decision',
      stoppedAt: 'calculate',
    });
    expect(
      waiting.result!.steps.map((step) => [step.stepId, step.state]),
    ).toEqual([
      ['calculate', 'waiting'],
      ['stock', 'completed'],
      ['order', 'waiting'],
    ]);

    // A denied request and a sandbox limit both escalate with their reason.
    const denied = await f.run(owner, item, {
      ...testCase,
      replies: { ...replies, order: { kind: 'capability', result: 'denied' } },
    });
    expect(denied.result).toMatchObject({
      outcome: 'escalated',
      stoppedAt: 'calculate',
      passed: false,
    });
    expect(denied.result!.steps[0]!.code?.outcome).toBe('capability_denied');
    outcome = 'resource_limit';
    const limited = await f.run(owner, item, testCase);
    expect(limited.state).toBe('completed');
    expect(limited.result!.steps).toEqual([
      expect.objectContaining({
        stepId: 'calculate',
        state: 'escalated',
        branch: 'escalated',
        code: expect.objectContaining({ outcome: 'resource_limit' }),
        note: 'The Code Step reached its time, memory or computation limit, so the workflow escalated to a person.',
      }),
    ]);

    // Without a configured runtime, drafts with Code Steps fail with a plain reason.
    const none = setup();
    const unavailable = await none.run(
      owner,
      none.draft(codeContent),
      testCase,
    );
    expect(unavailable).toMatchObject({
      state: 'failed',
      result: null,
      error:
        'Code Steps can’t run on this Luma server. Whoever runs the server needs to install the Code Step runtime.',
    });
  });

  it.skipIf(!existsSync(`${runtimeDirectory}/wasmtime`))(
    'runs a Code Step draft in the real sandbox',
    async () => {
      const f = setup({
        runner: createWasmtimeRunner({
          directory: runtimeDirectory,
          enforceProcessLimits: process.platform === 'linux',
        }),
      });
      const run = await f.run(owner, f.draft(codeContent), {
        ...defaultCase(codeContent, randomUUID()),
        inputs: { target: 10 },
        replies: {
          stock: { kind: 'read', values: { available: 4 } },
          order: { kind: 'capability', result: 'accepted' },
          'order-check': {
            kind: 'verification',
            state: 'verified',
            values: { reserved: true },
          },
        },
      });
      expect(run.result).toMatchObject({
        outcome: 'verified',
        steps: [
          expect.objectContaining({
            stepId: 'calculate',
            outputs: { quantity: 6 },
            code: expect.objectContaining({
              outcome: 'completed',
              requests: 2,
              verifiedActions: 1,
            }),
          }),
          expect.objectContaining({ stepId: 'stock' }),
          expect.objectContaining({ stepId: 'order' }),
          expect.objectContaining({ stepId: 'order-check' }),
          expect.objectContaining({ stepId: 'finish' }),
        ],
      });
    },
    30_000,
  );

  it('keeps saved cases with the draft and runs them again after the draft changes', async () => {
    const f = setup();
    const item = f.draft(content);
    const member = context('member');
    const passing = {
      ...example(),
      name: 'Happy',
      expected: { outcome: 'verified' as const },
    };
    const failing = {
      ...example(),
      name: 'Wrong expectation',
      expected: { outcome: 'ended' as const },
    };
    const missingRead = omit(example().replies, 'refresh');
    const unfit = { ...example(), name: 'Unfit', replies: missingRead };

    await expect(
      f.service.saveCases(member, item.id, { revision: 0, cases: [passing] }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.service.saveCases(owner, item.id, {
        revision: 0,
        cases: [passing, { ...failing, id: passing.id }],
      }),
    ).rejects.toThrow('Give each test case a unique ID.');
    const body = { revision: 0, cases: [passing, failing, unfit] };
    const saved = await f.service.saveCases(owner, item.id, body);
    expect(saved).toMatchObject({
      draftRevision: 1,
      revision: 1,
      blocked: null,
      results: [
        { caseId: passing.id, runId: null, passed: null, error: null },
        { caseId: failing.id, runId: null, passed: null, error: null },
        {
          caseId: unfit.id,
          runId: null,
          error: 'Give an example reply for this read.',
        },
      ],
    });
    // Retrying the same save is safe; a stale save is not.
    expect(await f.service.saveCases(owner, item.id, body)).toEqual(saved);
    await expect(
      f.service.saveCases(owner, item.id, { revision: 0, cases: [passing] }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const started = await f.service.runAll(owner, item.id, { revision: 1 });
    expect(started.results.map((result) => result.state)).toEqual([
      'running',
      'running',
      null,
    ]);
    await vi.waitFor(async () =>
      expect(
        (await f.service.cases(member, item.id)).results.map(
          (result) => result.state,
        ),
      ).toEqual(['completed', 'completed', null]),
    );
    const summary = await f.service.cases(member, item.id);
    expect(summary.results.map((result) => result.passed)).toEqual([
      true,
      false,
      null,
    ]);
    expect(summary.results[1]!.outcome).toBe('verified');
    const again = await f.service.runAll(owner, item.id, { revision: 1 });
    expect(again.results.map((result) => result.runId)).toEqual(
      summary.results.map((result) => result.runId),
    );
    expect(f.memory.runs.size).toBe(2);
    await expect(
      f.service.runAll(member, item.id, { revision: 1 }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Saving the draft creates a new revision; results reset until the cases run again.
    f.drafts.set(`${tenantId}:${item.id}`, { ...item, revision: 2 });
    await expect(
      f.service.runAll(owner, item.id, { revision: 1 }),
    ).rejects.toThrow('Reload the draft and run the test again.');
    expect(
      (await f.service.cases(owner, item.id)).results.map((r) => r.runId),
    ).toEqual([null, null, null]);
    await f.service.runAll(owner, item.id, { revision: 2 });
    await vi.waitFor(async () =>
      expect(
        (await f.service.cases(owner, item.id)).results.map((r) => r.passed),
      ).toEqual([true, false, null]),
    );
    expect(f.memory.runs.size).toBe(4);

    // A draft with errors reports why its cases cannot run.
    f.drafts.set(`${tenantId}:${item.id}`, {
      ...item,
      revision: 3,
      content: { ...content, steps: [] },
    });
    expect(
      (await f.service.runAll(owner, item.id, { revision: 3 })).blocked,
    ).toBeTruthy();
    expect(f.memory.runs.size).toBe(4);
  });

  it('prefills examples from declared fields, readable recent runs and adapter scenarios', async () => {
    const at = '2026-09-27T08:30:00.000Z';
    const recent = {
      run: {
        id: randomUUID(),
        tenantId,
        definitionId: 'restock',
        version: '1.0.0',
        versionDigest: 'a'.repeat(64),
        activationId: null,
        artifactDigest: null,
        trigger: { kind: 'manual' as const },
        subject: { kind: 'order', id: 'order-1' },
        actor: { kind: 'user' as const, id: 'owner-id' },
        context: {
          inputs: { quantity: 3 },
          evidence: {
            kind: 'inventory',
            facts: { ready: true },
            observations: [],
          },
          provenance: { reference: 'r', capturedAt: at },
        },
        contextDigest: 'd',
        createdAt: at,
      },
      steps: [
        {
          stepId: 'refresh',
          kind: 'read' as const,
          state: 'completed' as const,
          values: { ready: true },
          evidenceRefs: ['o'],
          recordedAt: at,
        },
        {
          stepId: 'reserve',
          kind: 'capability' as const,
          state: 'waiting' as const,
          values: {},
          evidenceRefs: ['d'],
          recordedAt: at,
        },
      ],
    };
    const f = setup({ recent: [recent] });
    const edit = f.draft(content, {
      basedOn: {
        definitionId: 'restock',
        version: '1.0.0',
        digest: 'a'.repeat(64),
      },
    });
    const member = context('member');
    const examples = await f.service.examples(member, edit.id);
    expect(examples.fields).toMatchObject({
      name: 'Example',
      inputs: { quantity: 0 },
      evidence: { ready: false },
    });
    expect(f.recentRuns).toHaveBeenCalledWith(member, 'restock');
    expect(examples.runs).toEqual([
      {
        runId: recent.run.id,
        createdAt: at,
        case: expect.objectContaining({
          name: 'Run from 2026-09-27 08:30 UTC',
          inputs: { quantity: 3 },
          evidence: { ready: true },
          replies: expect.objectContaining({
            refresh: { kind: 'read', values: { ready: true } },
            reserve: { kind: 'capability', result: 'approval_required' },
          }),
        }),
      },
    ]);
    expect(examples.scenarios).toEqual([
      expect.objectContaining({ id: 'happy', name: 'Happy path' }),
    ]);
    expect(examples.scenarios[0]!.case.id).not.toBe(
      f.scenarios.mock.results[0]!.value[0].case.id,
    );

    // A new workflow has no real runs to copy.
    f.recentRuns.mockClear();
    expect((await f.service.examples(owner, f.draft(content).id)).runs).toEqual(
      [],
    );
    expect(f.recentRuns).not.toHaveBeenCalled();

    // Membership is refreshed before any run is read.
    const removed = setup({
      recent: [recent],
      refresh: async () => {
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Insufficient organization role',
        );
      },
    });
    const draft = removed.draft(content, { basedOn: edit.basedOn });
    await expect(
      removed.service.examples(member, draft.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(removed.recentRuns).not.toHaveBeenCalled();
  });

  it('isolates drafts, saved cases and runs by workspace', async () => {
    const f = setup();
    const item = f.draft(content);
    const started = await f.service.start(owner, item.id, {
      id: randomUUID(),
      revision: 1,
      case: example(),
    });
    await f.settle(owner, item.id, started.id);
    const outsider = context('owner', 'owner-id', 'other-tenant');
    await expect(f.service.cases(outsider, item.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(f.service.examples(outsider, item.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      f.service.get(outsider, item.id, started.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.service.start(outsider, item.id, {
        id: randomUUID(),
        revision: 1,
        case: example(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.service.start(context('member'), item.id, {
        id: randomUUID(),
        revision: 1,
        case: example(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
