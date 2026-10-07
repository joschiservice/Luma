import {
  caseClasses,
  caseStates,
  fulfillmentSortSchema,
  fulfillmentViewSchema,
  orderPaymentStatusSchema,
  orderSortSchema,
  orderStatusSchema,
  orderViewSchema,
  returnStageSchema,
  returnViewSchema,
} from '@luma/api-contract';
import {
  assistantModelProfile,
  createWorkspaceAssistant,
} from '@luma/assistant/composition';
import { IdentityError } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import type {
  JsonValue,
  ModelAdapter,
  ModelRequest,
  Observation,
  Operation,
  TraceContext,
} from '@luma/platform';
import {
  createModelGateway,
  createObservability,
} from '@luma/platform/composition';
import { describe, expect, it, vi } from 'vitest';

const model = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
const tenantId = '00000000-0000-4000-8000-000000000001';
const firstOrder = '11111111-1111-4111-8111-111111111111';
const secondOrder = '22222222-2222-4222-8222-222222222222';
const unreadOrder = '33333333-3333-4333-8333-333333333333';

function context(userId = 'member-id') {
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
      'member',
    ),
    'request',
  );
}

function orderItem(id: string, number: string) {
  return {
    id,
    displayNumber: number,
    placedAt: '2026-09-29T08:00:00.000Z',
    total: { amount: '49.90', currency: 'EUR' },
    status: 'open',
    paymentStatus: 'paid',
    fulfillment: 'unfulfilled' as const,
    lineCount: 2,
    open: true,
    overdue: false,
    dueAt: null,
    issueIds: [],
    differs: false,
    sources: [
      {
        connectionId: '44444444-4444-4444-8444-444444444444',
        label: 'Shopify store',
        system: 'shopify',
        connectionStatus: 'active',
        externalId: '1001',
        selected: true,
        deleted: false,
        observedAt: '2026-10-05T09:00:00.000Z',
        sourceUpdatedAt: '2026-10-05T08:55:00.000Z',
      },
    ],
    observedAt: '2026-10-05T09:00:00.000Z',
    sourceUpdatedAt: '2026-10-05T08:55:00.000Z',
  };
}

type Reply =
  | string
  | { calls: { name: string; arguments: JsonValue }[] }
  | ((request: ModelRequest<unknown>) => Promise<never>);

/**
 * Builds the assistant with the real gateway and a scripted EU adapter. Each model call takes
 * the next reply; the requests the adapter received are kept for assertions.
 */
function setup(
  replies: Reply[],
  options: {
    available?: boolean;
    refreshContext?: (
      context: ReturnType<typeof makeTenantContext>,
    ) => Promise<ReturnType<typeof makeTenantContext>>;
    limits?: Parameters<typeof createWorkspaceAssistant>[0]['limits'];
    items?: ReturnType<typeof orderItem>[];
  } = {},
) {
  const requests: ModelRequest<unknown>[] = [];
  let call = 0;
  const adapter: ModelAdapter = {
    region: 'EU',
    supportsZeroDataRetention: true,
    async generate(_route, request) {
      // Later turns append to the same message list, so keep a copy of what this call saw.
      requests.push({ ...request, messages: [...request.messages] });
      const reply = replies[call++];
      if (reply === undefined) throw new Error('Unexpected model call');
      if (typeof reply === 'function') return reply(request);
      const usage = { inputTokens: 100, outputTokens: 20, costUsd: null };
      if (typeof reply === 'string')
        return { text: reply, toolCalls: [], usage };

      return {
        text: '',
        toolCalls: reply.calls.map((item, index) => ({
          id: `call-${call}-${index}`,
          ...item,
        })),
        usage,
      };
    },
  };
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 1,
    approvedModels: [model],
  });
  const gateway = createModelGateway(
    {
      routes: {
        [assistantModelProfile]: {
          adapter: 'bedrock-eu',
          model,
          providers: ['bedrock'],
          zeroDataRetention: true,
        },
      },
      timeoutMs: 30_000,
    },
    observability,
    { bedrockEu: adapter },
  );
  const items = options.items ?? [
    orderItem(firstOrder, '#1001'),
    orderItem(secondOrder, '#1002'),
  ];
  const orders = {
    list: vi.fn(async () => ({
      items,
      totalCount: items.length,
      nextCursor: null,
      asOf: '2026-10-05T10:00:00.000Z',
    })),
    get: vi.fn(async () => null),
  };
  const spans: Operation[] = [];
  const assistant = createWorkspaceAssistant({
    gateway,
    availability:
      options.available === false
        ? { available: false, reason: 'Configure the assistant route.' }
        : { available: true, reason: null },
    reads: {
      orders,
      issues: { list: vi.fn(), get: vi.fn() },
      inventory: { list: vi.fn() },
      fulfillment: { list: vi.fn() },
      returns: { list: vi.fn() },
    },
    refreshContext: options.refreshContext ?? (async (current) => current),
    observability: {
      run: async <T>(
        parent: TraceContext,
        operation: Operation,
        work: (context: TraceContext, observation: Observation) => Promise<T>,
      ) => {
        spans.push(operation);

        return work(parent, {
          context: parent,
          end: () => undefined,
          generation: () => undefined,
        });
      },
    },
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return { assistant, requests, orders, spans };
}

const question = {
  question: 'Which orders from last week are still unfulfilled?',
  history: [],
  timeZone: 'Europe/Berlin',
};

describe('workspace assistant', () => {
  it('answers from tool reads and cites only records it read', async () => {
    const { assistant, requests, orders, spans } = setup([
      {
        calls: [
          {
            name: 'search_orders',
            arguments: {
              view: 'outstanding',
              placedFrom: '2026-09-28T00:00:00+02:00',
              placedBefore: '2026-10-05T00:00:00+02:00',
            },
          },
        ],
      },
      `Two orders are still unfulfilled: #1001 [[order:${firstOrder}]] and #1002 [[order:${secondOrder}]]. Also [[order:${unreadOrder}]].`,
    ]);
    const asker = context();

    const answer = await assistant.ask(asker, question);

    expect(orders.list).toHaveBeenCalledWith(asker, {
      q: '',
      view: 'outstanding',
      placedFrom: '2026-09-27T22:00:00.000Z',
      placedBefore: '2026-10-04T22:00:00.000Z',
      sort: 'updated',
      direction: 'desc',
      limit: 10,
      count: 'exact',
    });
    expect(answer.outcome).toBe('answered');
    expect(answer.content).toBe(
      `Two orders are still unfulfilled: #1001 [[order:${firstOrder}]] and #1002 [[order:${secondOrder}]]. Also.`,
    );
    expect(answer.citations).toEqual([
      {
        kind: 'order',
        id: firstOrder,
        label: 'Order #1001',
        detail: 'Open · Unfulfilled',
        sources: [{ label: 'Shopify store', system: 'shopify' }],
        observedAt: '2026-10-05T09:00:00.000Z',
        sourceUpdatedAt: '2026-10-05T08:55:00.000Z',
      },
      expect.objectContaining({ id: secondOrder }),
    ]);
    expect(answer.steps).toEqual([
      {
        tool: 'search_orders',
        summary:
          'Searched orders · Outstanding · placed 2026-09-27 to 2026-10-04',
        outcome: 'ok',
        records: 2,
      },
    ]);
    expect(answer.usage).toEqual({
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 200,
      outputTokens: 40,
    });

    expect(requests[0]).toMatchObject({
      profile: 'assistant',
      dataPolicy: {
        classification: 'sensitive',
        region: 'EU',
        zeroDataRetention: true,
      },
    });
    expect(requests[0]!.tools!.map((tool) => tool.name)).toEqual([
      'search_orders',
      'get_order',
      'search_issues',
      'get_issue',
      'search_stock',
      'search_fulfillment',
      'search_returns',
    ]);
    // Tool filters offer exactly the values the matching pages accept.
    const enums = Object.fromEntries(
      requests[0]!.tools!.flatMap((tool) =>
        Object.entries(
          tool.input.jsonSchema.properties as Record<
            string,
            { enum?: string[] }
          >,
        ).flatMap(([field, schema]) =>
          schema.enum ? [[`${tool.name}.${field}`, schema.enum]] : [],
        ),
      ),
    );
    expect(enums).toMatchObject({
      'search_orders.view': orderViewSchema.options,
      'search_orders.status': orderStatusSchema.options,
      'search_orders.paymentStatus': orderPaymentStatusSchema.options,
      'search_orders.sort': orderSortSchema.options,
      'search_issues.class': [...caseClasses],
      'search_issues.state': [...caseStates],
      'search_fulfillment.view': fulfillmentViewSchema.options,
      'search_fulfillment.sort': fulfillmentSortSchema.options,
      'search_returns.view': returnViewSchema.options,
      'search_returns.stage': returnStageSchema.options,
    });

    const result = requests[1]!.messages.at(-1)!;
    expect(result).toMatchObject({ role: 'tool', callId: 'call-1-0' });
    expect(result.content).toContain(`"cite":"[[order:${firstOrder}]]"`);
    expect(spans).toEqual(['agent.run', 'tool.execute']);
  });

  it('reports why it is unavailable without calling a model', async () => {
    const { assistant, requests } = setup([], { available: false });

    await expect(assistant.availability(context())).resolves.toEqual({
      available: false,
      reason: 'Configure the assistant route.',
      reads: ['order', 'issue', 'stock_position', 'fulfillment', 'return'],
    });
    await expect(assistant.ask(context(), question)).rejects.toMatchObject({
      statusCode: 503,
      message: 'Configure the assistant route.',
    });
    expect(requests).toHaveLength(0);
  });

  it('gives nothing to someone who is no longer a member', async () => {
    const removed = setup(['Hello'], {
      refreshContext: async () => {
        throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');
      },
    });
    await expect(
      removed.assistant.ask(context(), question),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(removed.requests).toHaveLength(0);

    // Membership is checked again before reads, so removal during an answer stops it.
    let checks = 0;
    const midway = setup(
      [{ calls: [{ name: 'search_orders', arguments: {} }] }, 'Done'],
      {
        refreshContext: async (current) => {
          checks += 1;
          if (checks > 1)
            throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');

          return current;
        },
      },
    );
    await expect(
      midway.assistant.ask(context(), question),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(midway.orders.list).not.toHaveBeenCalled();
  });

  it('rejects a context whose actor changed', async () => {
    const { assistant, requests } = setup(['Hello'], {
      refreshContext: async () => context('someone-else'),
    });

    await expect(assistant.ask(context(), question)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(requests).toHaveLength(0);
  });

  it('returns invalid arguments to the model so it can correct them', async () => {
    const { assistant, requests, orders } = setup([
      { calls: [{ name: 'search_orders', arguments: { view: 'late' } }] },
      { calls: [{ name: 'search_orders', arguments: { view: 'overdue' } }] },
      `One is overdue: [[order:${firstOrder}]].`,
    ]);

    const answer = await assistant.ask(context(), question);

    expect(orders.list).toHaveBeenCalledTimes(1);
    expect(answer.steps.map((step) => step.outcome)).toEqual([
      'invalid_arguments',
      'ok',
    ]);
    const correction = JSON.parse(requests[1]!.messages.at(-1)!.content);
    expect(correction).toMatchObject({ error: 'invalid_arguments' });
    expect(correction.problems[0]).toMatch(/^view: /);
    expect(answer.citations).toHaveLength(1);
  });

  it('fails without running anything when the model calls an undeclared tool', async () => {
    const { assistant, orders } = setup([
      { calls: [{ name: 'cancel_order', arguments: { orderId: firstOrder } }] },
    ]);

    await expect(assistant.ask(context(), question)).rejects.toMatchObject({
      statusCode: 503,
      message:
        'Luma couldn’t read the model’s answer. Try again or rephrase your question.',
    });
    expect(orders.list).not.toHaveBeenCalled();
  });

  it('stops at the read and model call limits', async () => {
    const search = { calls: [{ name: 'search_orders', arguments: {} }] };
    const { assistant, orders } = setup(
      [
        { calls: [search.calls[0]!, search.calls[0]!, search.calls[0]!] },
        search,
        search,
      ],
      { limits: { toolCalls: 2, modelCalls: 3 } },
    );

    const answer = await assistant.ask(context(), question);

    expect(orders.list).toHaveBeenCalledTimes(2);
    expect(answer.outcome).toBe('incomplete');
    expect(answer.citations).toEqual([]);
    expect(answer.steps.map((step) => step.outcome)).toEqual([
      'ok',
      'ok',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(answer.usage).toMatchObject({ modelCalls: 3, toolCalls: 2 });
  });

  it('stops when the person cancels or the deadline passes', async () => {
    const hang = (request: ModelRequest<unknown>) =>
      new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const cancelled = setup([hang]);
    const controller = new AbortController();
    const pending = cancelled.assistant.ask(context(), question, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      statusCode: 503,
      message: 'The question was cancelled.',
    });

    const slow = setup([hang], { limits: { timeoutMs: 20 } });
    await expect(slow.assistant.ask(context(), question)).rejects.toMatchObject(
      {
        statusCode: 503,
        message: 'Answering took too long. Try a narrower question.',
      },
    );
  });

  it('bounds large read results before they reach the model', async () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      orderItem(
        `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
        `#${'9'.repeat(400)}${index}`,
      ),
    );
    const { assistant, requests } = setup(
      [{ calls: [{ name: 'search_orders', arguments: {} }] }, 'Many orders.'],
      { items },
    );

    const answer = await assistant.ask(context(), question);

    const result = requests[1]!.messages.at(-1)!.content;
    expect(result.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(result);
    expect(parsed.omitted).toBeGreaterThan(0);
    // Only the records the model saw are citable.
    expect(answer.steps[0]!.records).toBe(parsed.items.length);
  });

  it('starts the conversation at the first question in the history', async () => {
    const { assistant, requests } = setup(['Hello again.']);

    await assistant.ask(context(), {
      ...question,
      history: [
        { role: 'assistant', content: 'Hi! Ask me about your orders.' },
        { role: 'user', content: 'Any late orders?' },
        { role: 'assistant', content: 'None right now.' },
      ],
    });

    expect(requests[0]!.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(requests[0]!.messages[0]!.content).toContain('Europe/Berlin');
  });
});
