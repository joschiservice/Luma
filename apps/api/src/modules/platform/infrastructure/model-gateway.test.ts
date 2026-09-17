import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { createRoutedModelGateway } from '../application/model-gateway.js';
import type {
  ModelAdapter,
  ModelDataPolicy,
  ModelGateway,
  ModelRequest,
  ModelRoutingPolicy,
  ModelRoute,
  ModelSchema,
} from '../application/model-gateway.js';
import { createObservability } from './observability.js';
import { createVercelModelAdapter } from './vercel-model-adapter.js';

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
const request: ModelRequest<{ answer: string }> = {
  profile: 'reasoning',
  dataPolicy: {
    classification: 'public',
    region: 'unrestricted',
    zeroDataRetention: true,
  },
  messages: [{ role: 'user', content: 'synthetic-private@example.com' }],
  maxOutputTokens: 128,
  output: answer,
};
function completion(content = '{"answer":"synthetic-secret"}') {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
const shutdown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(shutdown.splice(0).map((close) => close()));
});
function setup(
  options: {
    model?: string;
    adapter?: ModelAdapter;
    policy?: ModelRoutingPolicy;
    response?: unknown;
    transport?: typeof fetch;
    zeroDataRetention?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const model = options.model ?? 'anthropic/claude-sonnet-4.5';
  const routes: Record<string, ModelRoute> = {
    reasoning: {
      adapter: 'vercel',
      model,
      providers: [model.split('/')[0]!],
      zeroDataRetention: options.zeroDataRetention ?? true,
    },
  };
  const spans = new InMemorySpanExporter();
  const langfuse = new InMemorySpanExporter();
  langfuse.shutdown = async () => {};
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 1,
      approvedModels: [model],
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
  const root = telemetry.request('00000000-0000-4000-8000-000000000001');
  const transport = vi.fn(
    options.transport ??
      (async () => Response.json(options.response ?? completion())),
  );
  const adapter =
    options.adapter ??
    createVercelModelAdapter(
      { apiKey: 'test-key', timeoutMs: options.timeoutMs ?? 1000 },
      transport,
    );
  let time = 0;
  const gateway = createRoutedModelGateway(
    routes,
    { vercel: adapter },
    telemetry,
    () => {
      time += 7;
      return time;
    },
    options.policy,
  );
  return { gateway, root, telemetry, spans, langfuse, transport };
}

describe('model gateway', () => {
  it('switches providers through configuration for the same model-backed workflow', async () => {
    // The workflow consumes only the public port, a profile and a typed output.
    async function workflow(
      gateway: ModelGateway,
      context: Parameters<ModelGateway['generate']>[0],
    ) {
      return (await gateway.generate(context, request)).output?.answer;
    }
    for (const model of ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1']) {
      const { gateway, root, telemetry, spans, langfuse, transport } = setup({
        model,
      });
      await telemetry.run(root.context, 'workflow.run', async (context) => {
        expect(await workflow(gateway, context)).toBe('synthetic-secret');
      });
      const [url, init] = transport.mock.calls[0]!;
      expect(url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model,
        max_tokens: 128,
        providerOptions: {
          gateway: { only: [model.split('/')[0]], zeroDataRetention: true },
        },
        response_format: {
          type: 'json_schema',
          json_schema: { strict: true, schema: answer.jsonSchema },
        },
      });
      const generation = spans
        .getFinishedSpans()
        .find((span) => span.name === 'model.generate')!;
      const parent = spans
        .getFinishedSpans()
        .find((span) => span.name === 'workflow.run')!;
      expect(generation.parentSpanContext?.spanId).toBe(
        parent.spanContext().spanId,
      );
      expect(generation.attributes).toMatchObject({
        'langfuse.observation.model.name': model,
        'langfuse.observation.usage_details': '{"input":10,"output":5}',
        'model.latency_ms': 7,
      });
      root.end();
      await telemetry.shutdown();
      expect(
        langfuse
          .getFinishedSpans()
          .some(
            (span) =>
              span.attributes['langfuse.observation.model.name'] === model,
          ),
      ).toBe(true);
      expect(
        JSON.stringify(
          langfuse.getFinishedSpans().map((span) => span.attributes),
        ),
      ).not.toMatch(/synthetic|test-key/);
    }
  });
  it.each<ModelDataPolicy>([
    { classification: 'sensitive', region: 'EU', zeroDataRetention: true },
    { classification: 'public', region: 'EU', zeroDataRetention: true },
    {
      classification: 'sensitive',
      region: 'unrestricted',
      zeroDataRetention: false,
    },
  ])(
    'rejects unsupported data placement before network I/O: %j',
    async (dataPolicy) => {
      const { gateway, root, transport } = setup();
      await expect(
        gateway.generate(root.context, { ...request, dataPolicy }),
      ).rejects.toMatchObject({ code: 'route_denied' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('cannot weaken retention through route selection', async () => {
    const { gateway, root, transport } = setup({ zeroDataRetention: false });
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code: 'route_denied' },
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    () => null,
    () => 'missing',
    () => 'constructor',
  ] as ModelRoutingPolicy[])(
    'allows policy denial but not unconfigured destinations',
    async (policy) => {
      const { gateway, root, transport } = setup({ policy });
      await expect(
        gateway.generate(root.context, request),
      ).rejects.toMatchObject({ code: 'route_denied' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('leaves Bedrock unavailable until an EU adapter is installed', async () => {
    const { root, telemetry, transport } = setup();
    const gateway = createRoutedModelGateway(
      {
        reasoning: {
          adapter: 'bedrock-eu',
          model: 'eu.model',
          providers: ['bedrock'],
          zeroDataRetention: true,
        },
      },
      {},
      telemetry,
      () => 0,
    );
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code: 'adapter_unavailable' },
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('accepts an EU adapter through the same port and exports cost without payloads', async () => {
    const adapter: ModelAdapter = {
      region: 'EU',
      supportsZeroDataRetention: true,
      generate: async () => ({
        text: '{"answer":"synthetic-secret"}',
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.001 },
      }),
    };
    const { gateway, root, spans } = setup({ adapter });
    const result = await gateway.generate(root.context, {
      ...request,
      dataPolicy: {
        classification: 'sensitive',
        region: 'EU',
        zeroDataRetention: true,
      },
    });
    expect(result.metadata).toMatchObject({ costUsd: 0.001, latencyMs: 7 });
    expect(
      spans.getFinishedSpans()[0]?.attributes[
        'langfuse.observation.cost_details'
      ],
    ).toBe('{"total":0.001}');
  });
  it.each([
    completion('not json'),
    completion('{"answer":5}'),
    { ...completion(), choices: [] },
    { ...completion(), usage: { prompt_tokens: -1, completion_tokens: 1 } },
    {
      ...completion(),
      choices: [{ finish_reason: 'length', message: { content: '{}' } }],
    },
    {
      ...completion(),
      choices: [
        {
          finish_reason: 'stop',
          message: { content: null, refusal: 'private content' },
        },
      ],
    },
  ])('rejects malformed, refused and incomplete output', async (response) => {
    const { gateway, root } = setup({ response });
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code: 'invalid_output' },
    );
  });
  it('returns validated tool proposals and maps tool-result history without executing', async () => {
    const tool = { name: 'lookup', description: 'Read a value', input: answer };
    const response = {
      ...completion(),
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"answer":"x"}' },
              },
            ],
          },
        },
      ],
    };
    const { gateway, root, transport } = setup({ response });
    const result = await gateway.generate(root.context, {
      ...request,
      tools: [tool],
    });
    expect(result.output).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'lookup', arguments: { answer: 'x' } },
    ]);
    transport.mockResolvedValueOnce(Response.json(completion()));
    await gateway.generate(root.context, {
      ...request,
      tools: [tool],
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', toolCalls: result.toolCalls },
        { role: 'tool', callId: 'call-1', content: 'result' },
      ],
    });
    expect(
      JSON.parse(String(transport.mock.calls[1]?.[1]?.body)).messages.slice(-2),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"answer":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ]);
  });
  it.each(['unknown', 'malformed', 'invalid', 'duplicate'])(
    'rejects %s tool calls',
    async (variant) => {
      const call = {
        id: 'call-1',
        type: 'function',
        function: {
          name: variant === 'unknown' ? 'other' : 'lookup',
          arguments:
            variant === 'malformed'
              ? '{'
              : variant === 'invalid'
                ? '{"answer":3}'
                : '{"answer":"x"}',
        },
      };
      const { gateway, root } = setup({
        response: {
          ...completion(),
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: variant === 'duplicate' ? [call, call] : [call],
              },
            },
          ],
        },
      });
      await expect(
        gateway.generate(root.context, {
          ...request,
          tools: [{ name: 'lookup', description: '', input: answer }],
        }),
      ).rejects.toMatchObject({ code: 'invalid_output' });
    },
  );
  it.each([401, 429, 500])(
    'sanitizes HTTP %s and makes no retry',
    async (status) => {
      const { gateway, root, transport, spans } = setup({
        transport: async () =>
          new Response('synthetic-private@example.com', { status }),
      });
      await expect(
        gateway.generate(root.context, request),
      ).rejects.toMatchObject({
        code: status === 429 ? 'rate_limited' : 'provider_error',
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(spans.getFinishedSpans()[0]?.status.code).toBe(2);
    },
  );
  it('sanitizes network exceptions', async () => {
    const { gateway, root } = setup({
      transport: async () => {
        throw new Error('secret prompt and key');
      },
    });
    await expect(gateway.generate(root.context, request)).rejects.toThrow(
      'Model generation failed: provider_error',
    );
  });
  it('rejects cancellation before egress', async () => {
    const { gateway, root, transport } = setup();
    await expect(
      gateway.generate(root.context, {
        ...request,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('bounds provider latency with an abort signal', async () => {
    const { gateway, root } = setup({
      timeoutMs: 5,
      transport: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private provider error')),
            { once: true },
          );
        }),
    });
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code: 'timeout' },
    );
  });
  it('reports missing cost as unknown rather than zero', async () => {
    const { gateway, root } = setup();
    expect(
      (await gateway.generate(root.context, request)).metadata.costUsd,
    ).toBeNull();
  });
});

it('rejects a malformed HTTP response without exposing its body', async () => {
  const { gateway, root } = setup({
    transport: async () => new Response('private malformed response'),
  });
  await expect(gateway.generate(root.context, request)).rejects.toThrow(
    'Model generation failed: invalid_output',
  );
});

it.each([0, -1, 1.5, 32769, NaN])(
  'rejects invalid token bounds before egress: %s',
  async (maxOutputTokens) => {
    const { gateway, root, transport } = setup();
    await expect(
      gateway.generate(root.context, { ...request, maxOutputTokens }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(transport).not.toHaveBeenCalled();
  },
);

it('supports caller cancellation while a request is in flight', async () => {
  const controller = new AbortController();
  const { gateway, root } = setup({
    transport: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('private transport data')),
          { once: true },
        );
        controller.abort();
      }),
  });
  await expect(
    gateway.generate(root.context, { ...request, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'aborted' });
});

it('excludes unapproved model names and invalid costs from telemetry', async () => {
  const { root, telemetry, spans } = setup();
  await telemetry.run(
    root.context,
    'model.generate',
    async (_context, observation) => {
      observation.generation({
        model: 'secret@example.com',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 1,
      });
    },
  );
  const attributes = spans.getFinishedSpans()[0]!.attributes;
  expect(attributes['langfuse.observation.model.name']).toBeUndefined();
  expect(JSON.stringify(attributes)).not.toContain('secret');
  await telemetry.run(
    root.context,
    'model.generate',
    async (_context, observation) => {
      observation.generation({
        model: 'anthropic/claude-sonnet-4.5',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: NaN,
        latencyMs: -1,
      });
    },
  );
  expect(
    spans.getFinishedSpans()[1]!.attributes[
      'langfuse.observation.cost_details'
    ],
  ).toBeUndefined();
  expect(
    spans.getFinishedSpans()[1]!.attributes['model.latency_ms'],
  ).toBeUndefined();
});
