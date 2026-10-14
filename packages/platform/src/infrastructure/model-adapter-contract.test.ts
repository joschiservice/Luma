import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  JsonValue,
  ModelAdapter,
  ModelDataPolicy,
  ModelRequest,
  ModelRoute,
  ModelSchema,
  ModelToolCall,
} from '../application/model-gateway.js';
import {
  createRoutedModelGateway,
  ModelGatewayError,
} from '../application/model-gateway.js';
import { createBedrockModelAdapter } from './bedrock-model-adapter.js';
import { createObservability } from './observability.js';
import { createVercelModelAdapter } from './vercel-model-adapter.js';

// Every model adapter must pass this suite with an intercepted transport. Add a fixture for
// each new adapter. Response bodies report 10 input and 5 output tokens.
interface AdapterFixture {
  readonly name: string;
  readonly route: ModelRoute;
  readonly dataPolicy: ModelDataPolicy;
  /** Credentials that must never appear in errors or telemetry. */
  readonly secrets: readonly string[];
  /** Builds the adapter; generation requests reach `inference`. */
  createAdapter(inference: typeof fetch, timeoutMs: number): ModelAdapter;
  text(content: string): unknown;
  output(name: string, value: JsonValue): unknown;
  toolCalls(calls: readonly ModelToolCall[]): unknown;
  /** Refused, truncated, filtered or malformed responses to a text request. */
  readonly invalidText: readonly (readonly [string, unknown])[];
  /** Malformed responses to a request that declares `answer` output and `lookup` tool. */
  readonly invalidStructured: readonly (readonly [string, unknown])[];
}

const vercel: AdapterFixture = {
  name: 'Vercel',
  route: {
    adapter: 'vercel',
    model: 'anthropic/claude-sonnet-4.5',
    providers: ['anthropic'],
    zeroDataRetention: true,
  },
  dataPolicy: {
    classification: 'public',
    region: 'unrestricted',
    zeroDataRetention: true,
  },
  secrets: ['test-api-key'],
  createAdapter: (inference, timeoutMs) =>
    createVercelModelAdapter({ apiKey: 'test-api-key', timeoutMs }, inference),
  text: (content) =>
    completion({ finish_reason: 'stop', message: { content } }),
  output: (_name, value) =>
    completion({
      finish_reason: 'stop',
      message: { content: JSON.stringify(value) },
    }),
  toolCalls: (calls) => chatToolCalls('tool_calls', calls),
  invalidText: [
    [
      'truncated',
      completion({
        finish_reason: 'length',
        message: { content: 'synthetic-response' },
      }),
    ],
    [
      'refused',
      completion({
        finish_reason: 'stop',
        message: {
          content: 'synthetic-response',
          refusal: 'synthetic-refusal',
        },
      }),
    ],
    ['missing choice', completion()],
    [
      'missing content',
      completion({ finish_reason: 'stop', message: { content: null } }),
    ],
    [
      'negative usage',
      {
        ...completion({
          finish_reason: 'stop',
          message: { content: 'synthetic-response' },
        }),
        usage: { prompt_tokens: -1, completion_tokens: 1 },
      },
    ],
  ],
  invalidStructured: [
    [
      'non-JSON text',
      completion({ finish_reason: 'stop', message: { content: 'x' } }),
    ],
    [
      'tool calls without the tool finish reason',
      chatToolCalls('stop', [
        { id: 'call-1', name: 'lookup', arguments: { answer: 'x' } },
      ]),
    ],
    [
      'malformed tool arguments',
      completion({
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{' },
            },
          ],
        },
      }),
    ],
  ],
};

const bedrockCredentials = {
  accessKeyId: 'AKIAEXAMPLECONTRACT',
  secretAccessKey: 'contract-secret-access-key',
  sessionToken: 'contract-session-token',
};

const bedrock: AdapterFixture = {
  name: 'Bedrock EU',
  route: {
    adapter: 'bedrock',
    model: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    providers: ['bedrock'],
    zeroDataRetention: true,
  },
  dataPolicy: {
    classification: 'sensitive',
    region: 'EU',
    zeroDataRetention: true,
  },
  secrets: Object.values(bedrockCredentials),
  createAdapter: (inference, timeoutMs) =>
    createBedrockModelAdapter(
      {
        region: 'eu-central-1',
        credentials: bedrockCredentials,
        timeoutMs,
      },
      async (url, init) => {
        // Retention and routing checks pass; generation goes to the contract transport.
        const { pathname } = new URL(String(url));
        if (pathname === '/data-retention')
          return Response.json({ mode: 'none' });
        if (pathname === '/logging/modelinvocations') return Response.json({});
        if (pathname.startsWith('/inference-profiles/'))
          return Response.json({
            models: [
              {
                modelArn:
                  'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
              },
            ],
          });

        return inference(url, init);
      },
      () => Date.parse('2026-09-28T12:00:00Z'),
    ),
  text: (content) => converse('end_turn', [{ text: content }]),
  output: (name, value) =>
    converse('tool_use', [
      { toolUse: { toolUseId: 'tooluse_output', name, input: value } },
    ]),
  toolCalls: (calls) =>
    converse(
      'tool_use',
      calls.map((call) => ({
        toolUse: { toolUseId: call.id, name: call.name, input: call.arguments },
      })),
    ),
  invalidText: [
    ['truncated', converse('max_tokens', [{ text: 'synthetic-response' }])],
    [
      'guardrail intervention',
      converse('guardrail_intervened', [{ text: 'synthetic-response' }]),
    ],
    [
      'content filter',
      converse('content_filtered', [{ text: 'synthetic-response' }]),
    ],
    [
      'malformed model output',
      converse('malformed_model_output', [{ text: 'synthetic-response' }]),
    ],
    ['empty content', converse('end_turn', [])],
    [
      'unexpected content block',
      converse('end_turn', [
        { reasoningContent: { reasoningText: { text: 'synthetic' } } },
        { text: 'synthetic-response' },
      ]),
    ],
    [
      'negative usage',
      {
        ...converse('end_turn', [{ text: 'synthetic-response' }]),
        usage: { inputTokens: -1, outputTokens: 1 },
      },
    ],
  ],
  invalidStructured: [
    [
      'plain text instead of the output tool',
      converse('end_turn', [{ text: '{"answer":"x"}' }]),
    ],
    [
      'tool use without the tool stop reason',
      converse('end_turn', [
        { toolUse: { toolUseId: 'a', name: 'answer', input: { answer: 'x' } } },
      ]),
    ],
    [
      'repeated structured output',
      converse('tool_use', [
        { toolUse: { toolUseId: 'a', name: 'answer', input: { answer: 'x' } } },
        { toolUse: { toolUseId: 'b', name: 'answer', input: { answer: 'y' } } },
      ]),
    ],
    [
      'structured output combined with a tool call',
      converse('tool_use', [
        { toolUse: { toolUseId: 'a', name: 'answer', input: { answer: 'x' } } },
        { toolUse: { toolUseId: 'b', name: 'lookup', input: { answer: 'y' } } },
      ]),
    ],
  ],
};

function completion(choice?: object) {
  return {
    choices: choice ? [choice] : [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function chatToolCalls(finishReason: string, calls: readonly ModelToolCall[]) {
  return completion({
    finish_reason: finishReason,
    message: {
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    },
  });
}

function converse(stopReason: string, content: unknown[]) {
  return {
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 12 },
  };
}

const answer: ModelSchema<{ answer: string }> = {
  name: 'answer',
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  parse: (value) => z.object({ answer: z.string() }).strict().parse(value),
};

const lookup = { name: 'lookup', description: 'Read a value', input: answer };

const shutdown: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(shutdown.splice(0).map((close) => close()));
});

describe.each([vercel, bedrock])('$name model adapter contract', (fixture) => {
  function setup(
    inference: typeof fetch = async () =>
      Response.json(fixture.text('synthetic-response')),
    timeoutMs = 1000,
  ) {
    const spans = new InMemorySpanExporter();
    const langfuse = new InMemorySpanExporter();
    langfuse.shutdown = async () => {};
    const telemetry = createObservability(
      {
        environment: 'test',
        release: 'test',
        sampleRate: 1,
        approvedModels: [fixture.route.model],
        langfuse: {
          publicKey: 'public',
          secretKey: 'secret',
          baseUrl: 'https://cloud.langfuse.com',
        },
      },
      {
        spanProcessors: [new SimpleSpanProcessor(spans)],
        langfuseExporter: langfuse,
      },
    );
    shutdown.push(() => telemetry.shutdown());
    const transport = vi.fn(inference);
    const gateway = createRoutedModelGateway(
      { contract: fixture.route },
      { [fixture.route.adapter]: fixture.createAdapter(transport, timeoutMs) },
      telemetry,
      () => 0,
    );
    const root = telemetry.request('00000000-0000-4000-8000-000000000001');
    const request = <T = string>(
      overrides: Partial<ModelRequest<T>> = {},
    ): ModelRequest<T> => ({
      profile: 'contract',
      dataPolicy: fixture.dataPolicy,
      messages: [
        { role: 'system', content: 'synthetic-instructions' },
        { role: 'user', content: 'synthetic-prompt' },
      ],
      maxOutputTokens: 128,
      ...overrides,
    });
    const exported = () =>
      JSON.stringify(
        [...spans.getFinishedSpans(), ...langfuse.getFinishedSpans()].map(
          (span) => [span.attributes, span.events, span.status],
        ),
      );

    return { gateway, root, telemetry, transport, request, exported, langfuse };
  }

  async function expectFailure(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => new Error('expected a model failure'),
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect(error).toMatchObject({
      code,
      message: `Model generation failed: ${code}`,
    });
    expect((error as Error).cause).toBeUndefined();
  }

  it('returns text with usage metadata', async () => {
    const { gateway, root, request } = setup();
    const result = await gateway.generate(root.context, request());
    expect(result.output).toBe('synthetic-response');
    expect(result.toolCalls).toEqual([]);
    expect(result.metadata).toMatchObject({
      adapter: fixture.route.adapter,
      model: fixture.route.model,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
    });
  });

  it('returns validated structured output', async () => {
    const { gateway, root, request } = setup(async () =>
      Response.json(fixture.output('answer', { answer: 'synthetic-response' })),
    );
    const result = await gateway.generate(
      root.context,
      request({ output: answer }),
    );
    expect(result.output).toEqual({ answer: 'synthetic-response' });
  });

  it('rejects structured output that fails the schema', async () => {
    const { gateway, root, request } = setup(async () =>
      Response.json(fixture.output('answer', { answer: 5 })),
    );
    await expectFailure(
      gateway.generate(root.context, request({ output: answer })),
      'invalid_output',
    );
  });

  it('returns tool proposals without executing them', async () => {
    const calls = [
      { id: 'call-1', name: 'lookup', arguments: { answer: 'synthetic-tool' } },
    ];
    const { gateway, root, request } = setup(async () =>
      Response.json(fixture.toolCalls(calls)),
    );
    const result = await gateway.generate(
      root.context,
      request({ output: answer, tools: [lookup] }),
    );
    expect(result.output).toBeNull();
    expect(result.toolCalls).toEqual(calls);
  });

  it('continues from tool results in the history', async () => {
    const { gateway, root, request, transport } = setup(async () =>
      Response.json(fixture.output('answer', { answer: 'synthetic-response' })),
    );
    const result = await gateway.generate(
      root.context,
      request({
        output: answer,
        tools: [lookup],
        messages: [
          { role: 'user', content: 'synthetic-prompt' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call-1', name: 'lookup', arguments: { answer: 'x' } },
            ],
          },
          { role: 'tool', callId: 'call-1', content: 'synthetic-tool' },
        ],
      }),
    );
    expect(result.output).toEqual({ answer: 'synthetic-response' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects proposals for undeclared tools', async () => {
    const { gateway, root, request } = setup(async () =>
      Response.json(
        fixture.toolCalls([{ id: 'call-1', name: 'other', arguments: {} }]),
      ),
    );
    await expectFailure(
      gateway.generate(root.context, request({ tools: [lookup] })),
      'invalid_output',
    );
  });

  it('rejects a non-JSON body without exposing it', async () => {
    const { gateway, root, request } = setup(
      async () => new Response('synthetic-error'),
    );
    await expectFailure(
      gateway.generate(root.context, request()),
      'invalid_output',
    );
  });

  it.each(fixture.invalidText)(
    'rejects %s text output',
    async (_name, body) => {
      const { gateway, root, request } = setup(async () => Response.json(body));
      await expectFailure(
        gateway.generate(root.context, request()),
        'invalid_output',
      );
    },
  );

  it.each(fixture.invalidStructured)(
    'rejects %s for structured requests',
    async (_name, body) => {
      const { gateway, root, request } = setup(async () => Response.json(body));
      await expectFailure(
        gateway.generate(
          root.context,
          request({ output: answer, tools: [lookup] }),
        ),
        'invalid_output',
      );
    },
  );

  it.each([
    [429, 'rate_limited'],
    [400, 'provider_error'],
    [401, 'provider_error'],
    [500, 'provider_error'],
    [503, 'provider_error'],
  ])('maps HTTP %s to %s without retries or payloads', async (status, code) => {
    const { gateway, root, request, transport, exported } = setup(
      async () => new Response('synthetic-error synthetic-prompt', { status }),
    );
    await expectFailure(gateway.generate(root.context, request()), code);
    expect(transport).toHaveBeenCalledTimes(1);
    root.end();
    expect(exported()).not.toMatch(/synthetic/);
  });

  it('sanitizes network exceptions', async () => {
    const { gateway, root, request } = setup(async () => {
      throw new Error(`synthetic-error ${fixture.secrets.join(' ')}`);
    });
    await expectFailure(
      gateway.generate(root.context, request()),
      'provider_error',
    );
  });

  it('reports caller cancellation while the request is in flight', async () => {
    const controller = new AbortController();
    const { gateway, root, request } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('synthetic-error')),
            { once: true },
          );
          controller.abort();
        }),
    );
    await expectFailure(
      gateway.generate(root.context, request({ signal: controller.signal })),
      'aborted',
    );
  });

  it('bounds provider latency with the configured timeout', async () => {
    const { gateway, root, request } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('synthetic-error')),
            { once: true },
          );
        }),
      5,
    );
    await expectFailure(gateway.generate(root.context, request()), 'timeout');
  });

  it('exports usage to Langfuse without prompts, responses, tool data or credentials', async () => {
    const { gateway, root, telemetry, request, exported, langfuse } = setup(
      async () =>
        Response.json(
          fixture.toolCalls([
            {
              id: 'call-2',
              name: 'lookup',
              arguments: { answer: 'synthetic-tool' },
            },
          ]),
        ),
    );
    await gateway.generate(
      root.context,
      request({
        tools: [lookup],
        messages: [
          { role: 'user', content: 'synthetic-prompt' },
          {
            role: 'assistant',
            content: 'synthetic-response',
            toolCalls: [
              {
                id: 'call-1',
                name: 'lookup',
                arguments: { answer: 'synthetic-tool' },
              },
            ],
          },
          { role: 'tool', callId: 'call-1', content: 'synthetic-tool' },
        ],
      }),
    );
    root.end();
    await telemetry.shutdown();
    expect(
      langfuse
        .getFinishedSpans()
        .some(
          (span) =>
            span.attributes['langfuse.observation.model.name'] ===
            fixture.route.model,
        ),
    ).toBe(true);
    const telemetryText = exported();
    expect(telemetryText).not.toMatch(/synthetic/);
    for (const secret of fixture.secrets)
      expect(telemetryText).not.toContain(secret);
  });
});
