import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { ModelGateway, ModelRequest } from '@luma/platform';
import { ModelGatewayError } from '@luma/platform';
import { describe, expect, it, vi } from 'vitest';

import {
  createDraftGeneration,
  type GenerationRecord,
  type GenerationStore,
} from '../application/draft-generation.js';
import {
  createWorkflowDrafts,
  type StoredWorkflowDraft,
  type WorkflowDraftStore,
} from '../application/drafts.js';
import { codeRuntime } from '../domain/code-step.js';
import type { WorkflowDraftContent } from '../domain/draft.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import type { VocabularyContribution } from '../domain/vocabulary.js';
import {
  codeSourceProblem,
  codeStepOutput,
  draftOutput,
} from './generation-output.js';
import { playbookHash } from './playbooks/schema.js';
import {
  checkDraftContent,
  draftFromVersion,
  parseDraftShape,
} from './process-schema.js';

const tenantId = 'tenant';

function context(role: 'owner' | 'admin' | 'member', userId = `${role}-id`) {
  return makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Tenant',
      slug: 'tenant',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership(
      { id: `membership-${userId}`, organizationId: tenantId, userId },
      role,
    ),
    'request',
  );
}

const unavailable = { executable: false, reason: 'Built-in only.' };

const procurement: VocabularyContribution = {
  subjects: [
    {
      kind: 'inventory_position',
      label: 'Stock position',
      description: '',
      ...unavailable,
    },
  ],
  reads: [
    {
      source: 'inventory',
      label: 'Current stock',
      description: '',
      fields: { available: 'number', fresh: 'boolean' },
      ...unavailable,
    },
  ],
  capabilities: [
    {
      capability: 'procurement.purchase-order.create',
      version: '1',
      label: 'Create a purchase-order draft',
      description: '',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      approval: 'Policy decides.',
      parameters: { quantity: 'number' },
      postcondition: { status: 'string' },
      evaluators: ['procurement/1'],
      ...unavailable,
    },
  ],
  evaluators: [
    {
      version: 'procurement/1',
      label: 'Check the draft',
      description: '',
      fields: { status: 'string' },
      ...unavailable,
    },
  ],
};

const computation: VocabularyContribution = {
  triggers: [{ kind: 'manual', executable: true }],
  subjects: [
    {
      kind: 'order',
      label: 'Order',
      description: '',
      executable: true,
      reason: null,
    },
  ],
  stepKinds: (['code', 'condition', 'wait', 'end'] as const).map((kind) => ({
    kind,
    executable: true,
  })),
  codeSteps: { executable: true, reason: null, evaluation: true },
};

const limits = {
  fuel: 100_000_000,
  memoryBytes: 67_108_864,
  wallTimeMs: 5000,
  maxRequests: 0,
};

/** Reorders stock with an installed read, action and result check. */
const replenish: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: {
    id: 'low-stock',
    name: 'Reorder low stock',
    intent: 'Draft a purchase order when stock is low.',
    category: 'procurement',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'condition', field: 'belowMinimum', equals: true },
    subjectKind: 'inventory_position',
  },
  inputs: {},
  context: {
    kind: 'replenishment',
    fields: { belowMinimum: 'boolean' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'stock',
      kind: 'read',
      source: 'inventory',
      fields: { fresh: 'boolean', available: 'number' },
    },
    {
      id: 'fresh',
      kind: 'condition',
      field: 'fresh',
      equals: true,
      onFalse: 'escalate',
    },
    {
      id: 'order',
      kind: 'capability',
      capability: 'procurement.purchase-order.create',
      capabilityVersion: '1',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      parameters: { quantity: { source: 'literal', value: 20 } },
      expectedPostcondition: { status: { source: 'literal', value: 'draft' } },
    },
    {
      id: 'check-order',
      kind: 'verification',
      forStep: 'order',
      evaluatorVersion: 'procurement/1',
      maxDurationSeconds: 60,
      fields: { status: 'string' },
    },
    { id: 'done', kind: 'end', outcome: 'Order drafted' },
  ],
};

/** A computation workflow with a condition and a wait. */
const held: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: {
    id: 'held-orders',
    name: 'Check held orders',
    intent: 'Wait for held orders.',
    category: 'custom',
  },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  inputs: { limit: 'number' },
  context: { kind: 'manual', fields: { held: 'boolean' }, maxAgeSeconds: 300 },
  steps: [
    {
      id: 'still-held',
      kind: 'condition',
      field: 'held',
      equals: true,
      onFalse: 'end',
    },
    { id: 'pause', kind: 'wait', seconds: 60 },
    { id: 'done', kind: 'end', outcome: 'Checked' },
  ],
};

const answer = (content: unknown, extra: Record<string, unknown> = {}) => ({
  content,
  steps: [],
  assumptions: ['The usual supplier is the one set in Procurement.'],
  questions: [],
  ...extra,
});

/** Swaps the installed action for one this workspace hasn't installed. */
const unknownAction = (content: WorkflowDraftContent) => ({
  ...content,
  steps: content.steps.map((step) =>
    step.kind === 'capability'
      ? {
          ...step,
          capability: 'payments.refund.create',
          targetKind: 'payment',
        }
      : step,
  ),
});

type Reply =
  { output: unknown } | { error: ModelGatewayError['code'] } | 'hang';

/** Answers from a queue like the gateway: parses structured output and rejects what fails. */
function fakeGateway(replies: Reply[]) {
  const requests: ModelRequest<unknown>[] = [];
  const gateway: ModelGateway = {
    async generate<T>(_trace: unknown, request: ModelRequest<T>) {
      // Messages grow between attempts, so keep a copy of what this call sent.
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
      } as ModelRequest<unknown>);
      const reply = replies.shift();
      if (!reply) throw new Error('No more replies');
      if (reply === 'hang')
        return new Promise<never>((_resolve, reject) =>
          request.signal?.addEventListener('abort', () =>
            reject(new ModelGatewayError('aborted')),
          ),
        );
      if ('error' in reply) throw new ModelGatewayError(reply.error);
      let output: T;
      try {
        output = request.output!.parse(structuredClone(reply.output));
      } catch {
        throw new ModelGatewayError('invalid_output');
      }

      return {
        output,
        toolCalls: [],
        metadata: {
          inputTokens: 100,
          outputTokens: 50,
          costUsd: null,
          adapter: 'bedrock-eu' as const,
          model: 'eu.test-model',
          latencyMs: 1,
        },
      };
    },
  };

  return { gateway, requests };
}

function setup(
  replies: Reply[],
  options: { available?: boolean; timeoutMs?: number } = {},
) {
  const drafts = new Map<string, StoredWorkflowDraft>();
  const published: ProcessWorkflowVersion[] = [];
  const records = new Map<string, GenerationRecord>();
  const store: WorkflowDraftStore = {
    list: async () => [...drafts.values()],
    get: async (_context, id) => structuredClone(drafts.get(id) ?? null),
    transaction: async (_context, operation) =>
      operation({
        lock: async (id) => structuredClone(drafts.get(id) ?? null),
        insert: async (draft) => {
          if (drafts.has(draft.id)) return false;
          drafts.set(draft.id, structuredClone(draft));

          return true;
        },
        update: async (draft) => {
          drafts.set(draft.id, structuredClone(draft));
        },
        publish: async (version) => {
          published.push(version);
        },
        audit: async () => undefined,
      }),
  };
  const service = createWorkflowDrafts({
    store,
    versions: async () => [],
    reserved: async () => new Set(),
    sources: [
      { vocabulary: async () => procurement },
      { vocabulary: async () => computation },
    ],
    codeStep: { runtime: codeRuntime, limits },
    parseShape: parseDraftShape,
    check: checkDraftContent,
    fromVersion: draftFromVersion,
    refreshContext: async (item) => item,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date('2026-09-28T10:00:00Z'),
  });
  const publish = vi.spyOn(service, 'publish');
  const generationStore: GenerationStore = {
    get: async (_context, id) => structuredClone(records.get(id) ?? null),
    insert: async (_context, record) => {
      if (records.has(record.id)) return false;
      records.set(record.id, structuredClone(record));

      return true;
    },
    list: async (_context, draftId) =>
      [...records.values()].filter((item) => item.draftId === draftId),
    decide: async (_context, id, decision) => {
      const record = records.get(id);
      if (record?.proposal?.state !== 'open') return false;
      const { resultingRevision, ...proposal } = decision;
      records.set(id, { ...record, resultingRevision, proposal });

      return true;
    },
  };
  const model = fakeGateway(replies);
  const generation = createDraftGeneration({
    gateway: model.gateway,
    availability:
      options.available === false
        ? { available: false, reason: 'No EU model route is configured.' }
        : { available: true, reason: null },
    drafts: service,
    store: generationStore,
    outputs: { draft: draftOutput, codeStep: codeStepOutput },
    compileCode: codeSourceProblem,
    refreshContext: async (item) => item,
    hash: playbookHash,
    id: randomUUID,
    now: () => new Date('2026-09-28T10:00:00Z'),
    trace: (item) => ({ requestId: item.requestId, traceId: 't', spanId: 's' }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });

  return {
    generation,
    drafts: service,
    stored: drafts,
    records,
    published,
    publish,
    requests: model.requests,
  };
}

const describeRequest = (prompt = 'Reorder 20 units when stock is low.') => ({
  id: randomUUID(),
  draftId: randomUUID(),
  prompt,
});

describe('draft generation', () => {
  it('limits the output schema to installed vocabulary and sends tenant text as sensitive EU data', async () => {
    const env = setup([{ output: answer(replenish) }]);
    const result = await env.generation.describe(
      context('admin'),
      describeRequest(),
    );
    expect(result.generation.outcome).toBe('valid');
    expect(result.draft).toEqual(
      expect.objectContaining({
        revision: 1,
        mode: 'language',
        state: 'draft',
      }),
    );
    expect(result.draft.content.definition.id).toMatch(
      /^low-stock-[a-f0-9]{6}$/,
    );

    const [request] = env.requests;
    expect(request!.profile).toBe('authoring');
    expect(request!.dataPolicy).toEqual({
      classification: 'sensitive',
      region: 'EU',
      zeroDataRetention: true,
    });
    const schema = JSON.stringify(request!.output!.jsonSchema);
    const enums = [...schema.matchAll(/"enum":\[([^\]]*)\]/g)].map(
      (match) => match[1],
    );
    expect(enums).toContain('"procurement.purchase-order.create"');
    expect(enums).toContain('"inventory"');
    expect(enums).toContain('"procurement/1"');
    expect(enums).toContain('"inventory_position","order"');
    expect(schema).not.toContain('payments.refund.create');
    expect(schema).toContain('"code"');
    expect(env.published).toEqual([]);
    expect(env.publish).not.toHaveBeenCalled();
  });

  it('rejects an uninstalled action and asks the model again with the problem', async () => {
    const env = setup([
      { output: answer(unknownAction(replenish)) },
      { output: answer(replenish) },
    ]);
    const result = await env.generation.describe(
      context('owner'),
      describeRequest(),
    );
    expect(result.generation).toEqual(
      expect.objectContaining({ outcome: 'valid', attempts: 2 }),
    );
    expect(env.requests).toHaveLength(2);
    const retry = env.requests[1]!.messages;
    expect(retry.at(-2)?.role).toBe('assistant');
    expect(retry.at(-1)?.content).toContain('step "order", field "capability"');
    expect(retry.at(-1)?.content).toContain(
      'Unknown capability payments.refund.create@1',
    );
    expect(
      result.draft.content.steps.find((step) => step.id === 'order'),
    ).toMatchObject({ capability: 'procurement.purchase-order.create' });
    expect(result.generation.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      costUsd: null,
    });
    expect(result.generation.route).toEqual({
      profile: 'authoring',
      adapter: 'bedrock-eu',
      model: 'eu.test-model',
    });
  });

  it('keeps the best answer after bounded retries and turns uninstalled entries into questions', async () => {
    const noCheck = {
      ...unknownAction(replenish),
      steps: unknownAction(replenish).steps.filter(
        (step) => step.kind !== 'verification',
      ),
    };
    const env = setup([
      { output: answer(noCheck) },
      {
        output: answer(unknownAction(replenish), {
          questions: [
            {
              stepId: 'order',
              field: 'parameters.quantity',
              question: 'How many units?',
            },
          ],
        }),
      },
      { output: answer(noCheck) },
    ]);
    const result = await env.generation.describe(
      context('admin'),
      describeRequest(),
    );
    expect(env.requests).toHaveLength(3);
    expect(result.generation.outcome).toBe('partial');
    expect(result.generation.attempts).toBe(3);
    const order = result.draft.content.steps.find(
      (step) => step.id === 'order',
    );
    expect(order).toMatchObject({
      kind: 'capability',
      capability: '',
      capabilityVersion: '',
      parameters: {},
    });
    expect(result.draft.content.steps.map((step) => step.id)).toContain(
      'check-order',
    );
    expect(result.generation.questions).toEqual(
      expect.arrayContaining([
        {
          stepId: 'order',
          field: 'parameters.quantity',
          question: 'How many units?',
        },
        expect.objectContaining({ stepId: 'order', field: 'capability' }),
      ]),
    );
    expect(
      result.generation.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'order', field: 'capability' }),
      ]),
    );
    expect(result.generation.explanations.map((item) => item.stepId)).toEqual(
      result.draft.content.steps.map((step) => step.id),
    );
    expect(JSON.stringify(result.draft.content)).not.toContain(
      'payments.refund.create',
    );
  });

  it('leaves no draft and offers a retry when the model fails, times out or is cancelled', async () => {
    const secret = 'MODEL-TEXT-SECRET';
    const cases: {
      replies: Reply[];
      message: RegExp;
      calls: number;
      signal?: () => AbortSignal;
    }[] = [
      { replies: ['hang'], message: /took too long.*Try again/, calls: 1 },
      {
        replies: [{ error: 'provider_error' }],
        message: /couldn’t answer.*Try again/,
        calls: 1,
      },
      {
        replies: [{ error: 'rate_limited' }],
        message: /busy.*Try again/,
        calls: 1,
      },
      {
        replies: [
          { output: { content: secret } },
          { output: { note: secret } },
          { output: answer({ steps: secret }) },
        ],
        message: /couldn’t turn.*Try again/,
        calls: 3,
      },
      {
        replies: ['hang'],
        message: /cancelled/,
        calls: 1,
        signal: () => AbortSignal.timeout(20),
      },
    ];
    for (const item of cases) {
      const env = setup(item.replies, { timeoutMs: 100 });
      const request = describeRequest();
      const failure = await env.generation
        .describe(context('admin'), request, { signal: item.signal?.() })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        statusCode: 503,
        message: expect.stringMatching(item.message),
      });
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).message).toContain('No draft was created.');
      expect(env.requests).toHaveLength(item.calls);
      expect(env.stored.size).toBe(0);
      expect([...env.records.values()]).toEqual([
        expect.objectContaining({
          kind: 'describe',
          draftId: null,
          outcome: 'failed',
          result: null,
        }),
      ]);
      expect(env.records.has(request.id)).toBe(false);
    }
  });

  it('checks authorization before availability and never calls the model when unavailable', async () => {
    const env = setup([{ output: answer(replenish) }], { available: false });
    await expect(
      env.generation.describe(context('member'), describeRequest()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      env.generation.describe(context('admin'), describeRequest()),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: 'No EU model route is configured.',
    });
    expect(await env.generation.availability(context('member'))).toEqual({
      available: false,
      reason: 'No EU model route is configured.',
    });
    expect(env.requests).toHaveLength(0);
    expect(env.stored.size).toBe(0);
  });

  it('replays a repeated describe request and rejects a reused ID with another body', async () => {
    const env = setup([{ output: answer(replenish) }]);
    const request = describeRequest();
    const first = await env.generation.describe(context('admin'), request);
    expect(await env.generation.describe(context('admin'), request)).toEqual(
      first,
    );
    await expect(
      env.generation.describe(context('admin'), {
        ...request,
        prompt: 'Something else',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(env.requests).toHaveLength(1);
    expect(
      await env.generation.generations(context('member'), request.draftId),
    ).toEqual([
      expect.objectContaining({
        id: request.id,
        kind: 'describe',
        resultingRevision: 1,
        promptVersion: 'workflow-authoring/1',
        promptDigest: playbookHash(request.prompt),
        outcome: 'valid',
      }),
    ]);
  });

  it('proposes step-level changes and applies them only when accepted at the same revision', async () => {
    const changed: WorkflowDraftContent = {
      ...held,
      definition: { ...held.definition, id: 'renamed', name: 'Held orders' },
      version: '9.9.9',
      steps: [
        { id: 'pause', kind: 'wait', seconds: 60 },
        {
          id: 'still-held',
          kind: 'condition',
          field: 'held',
          equals: false,
          onFalse: 'end',
        },
        { id: 'again', kind: 'wait', seconds: 30 },
        { id: 'done', kind: 'end', outcome: 'Checked' },
      ],
    };
    const env = setup([
      { output: answer(changed) },
      { output: answer(changed) },
      { output: answer(held) },
    ]);
    const admin = context('admin');
    const draftId = randomUUID();
    await env.drafts.create(admin, {
      id: draftId,
      mode: 'visual',
      start: { kind: 'content', content: held },
    });

    const proposal = await env.generation.refine(admin, draftId, {
      id: randomUUID(),
      revision: 1,
      instruction: 'Wait first, then check the order is released.',
    });
    expect(proposal.state).toBe('open');
    expect(proposal.content.definition).toEqual({
      ...held.definition,
      name: 'Held orders',
    });
    expect(proposal.content.version).toBe('1.0.0');
    expect(
      proposal.changes.map((item) => [item.change, item.stepId ?? item.field]),
    ).toEqual([
      ['changed', 'definition'],
      ['moved', 'still-held'],
      ['changed', 'still-held'],
      ['added', 'again'],
    ]);
    expect((await env.drafts.get(admin, draftId)).revision).toBe(1);

    // The draft changes after the proposal, so accepting it would overwrite that edit.
    await env.drafts.save(admin, draftId, {
      saveId: randomUUID(),
      revision: 1,
      mode: 'visual',
      content: { ...held, definition: { ...held.definition, name: 'Edited' } },
    });
    await expect(
      env.generation.accept(admin, draftId, proposal.id, {
        revision: 1,
        saveId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await env.drafts.get(admin, draftId)).content.definition.name).toBe(
      'Edited',
    );

    const current = await env.generation.refine(admin, draftId, {
      id: randomUUID(),
      revision: 2,
      instruction: 'Wait first.',
    });
    const saveId = randomUUID();
    const accepted = await env.generation.accept(admin, draftId, current.id, {
      revision: 2,
      saveId,
    });
    expect(accepted.draft).toEqual(
      expect.objectContaining({ revision: 3, mode: 'language' }),
    );
    expect(accepted.draft.content).toEqual(current.content);
    expect(accepted.proposal).toEqual(
      expect.objectContaining({ state: 'accepted', resultingRevision: 3 }),
    );
    expect(
      await env.generation.accept(admin, draftId, current.id, {
        revision: 2,
        saveId,
      }),
    ).toEqual(accepted);
    await expect(
      env.generation.reject(admin, draftId, current.id),
    ).rejects.toMatchObject({ statusCode: 409 });

    const unwanted = await env.generation.refine(admin, draftId, {
      id: randomUUID(),
      revision: 3,
      instruction: 'Undo that.',
    });
    expect(
      (await env.generation.reject(admin, draftId, unwanted.id)).proposal.state,
    ).toBe('rejected');
    await expect(
      env.generation.accept(admin, draftId, unwanted.id, {
        revision: 3,
        saveId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await env.drafts.get(admin, draftId)).revision).toBe(3);
    await expect(
      env.generation.refine(context('member'), draftId, {
        id: randomUUID(),
        revision: 3,
        instruction: 'Anything',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      env.generation.accept(admin, draftId, randomUUID(), {
        revision: 3,
        saveId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(env.publish).not.toHaveBeenCalled();
    expect(env.published).toEqual([]);
  });

  it('re-asks for Code Step source that does not compile and never saves the suggestion', async () => {
    const valid = {
      source:
        'function main(input) { return { total: input.inputs.limit * 2 }; }',
      fields: { total: 'number' },
      grants: [],
      explanation: 'Doubles the limit.',
      examples: [
        {
          name: 'Doubles',
          input: { inputs: { limit: 2 }, evidence: {}, steps: {} },
          replies: {},
          expected: { total: 4 },
        },
      ],
    };
    const env = setup([
      {
        output: {
          ...valid,
          source: "import x from 'y';\nfunction main() { return {}; }",
        },
      },
      { output: valid },
    ]);
    const admin = context('admin');
    const draftId = randomUUID();
    await env.drafts.create(admin, {
      id: draftId,
      mode: 'visual',
      start: { kind: 'content', content: held },
    });
    const suggestion = await env.generation.codeStep(admin, draftId, {
      id: randomUUID(),
      revision: 1,
      stepId: null,
      description: 'Double the limit.',
    });
    expect(suggestion).toEqual(
      expect.objectContaining({
        outcome: 'valid',
        attempts: 2,
        source: valid.source,
        fields: { total: 'number' },
        diagnostics: [],
      }),
    );
    expect(env.requests[1]!.messages.at(-1)?.content).toContain(
      'field "source"',
    );
    expect((await env.drafts.get(admin, draftId)).revision).toBe(1);
    expect(
      (await env.generation.generations(admin, draftId)).map((item) => [
        item.kind,
        item.outcome,
      ]),
    ).toEqual([['code_step', 'valid']]);
  });
});
