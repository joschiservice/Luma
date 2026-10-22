import { createHash } from 'node:crypto';

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  ModelMessage,
  ModelRequest,
  ModelRoute,
  ModelSchema,
} from '../application/model-gateway.js';
import {
  authoringModelProfile,
  createRoutedModelGateway,
} from '../application/model-gateway.js';
import {
  bedrockRegionalAwsRegions,
  createBedrockModelAdapter,
} from './bedrock-model-adapter.js';
import { createObservability } from './observability.js';

const credentials = {
  accessKeyId: 'AKIAEXAMPLEBEDROCK',
  secretAccessKey: 'bedrock-secret-access-key',
  sessionToken: 'bedrock-session-token',
};

it('allows AU inference only when every destination stays in Australia', async () => {
  for (const destinations of [
    ['ap-southeast-2', 'ap-southeast-4'],
    ['ap-southeast-2', 'ap-southeast-1'],
  ]) {
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/data-retention')
        return Response.json({ mode: 'none' });
      if (url.pathname === '/logging/modelinvocations')
        return Response.json({});
      if (url.pathname.startsWith('/inference-profiles/'))
        return Response.json(profile(...destinations));

      return Response.json(converse('end_turn', [{ text: 'verified' }]));
    });
    const adapter = createBedrockModelAdapter(
      {
        region: 'ap-southeast-2',
        dataRegion: 'AU',
        credentials,
        timeoutMs: 1000,
      },
      transport,
    );
    const auRoute = {
      ...route,
      model: 'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
    };
    const auRequest = {
      ...request,
      dataPolicy: { ...request.dataPolicy, region: 'AU' as const },
    };
    if (destinations.includes('ap-southeast-1')) {
      await expect(adapter.generate(auRoute, auRequest)).rejects.toMatchObject({
        code: 'route_denied',
      });
      expect(
        transport.mock.calls.some(([url]) => String(url).includes('/converse')),
      ).toBe(false);
    } else {
      expect((await adapter.generate(auRoute, auRequest)).text).toBe(
        'verified',
      );
    }
    transport.mockClear();
    await expect(
      adapter.generate({ ...auRoute, model }, auRequest),
    ).rejects.toMatchObject({ code: 'route_denied' });
    expect(transport).not.toHaveBeenCalled();
  }
});

const model = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

const route: ModelRoute = {
  adapter: 'bedrock',
  model,
  providers: ['bedrock'],
  zeroDataRetention: true,
};

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

const request: ModelRequest<unknown> = {
  tenantId: 'tenant-1',
  profile: authoringModelProfile,
  dataPolicy: {
    classification: 'sensitive',
    region: 'EU',
    zeroDataRetention: true,
  },
  messages: [{ role: 'user', content: 'synthetic-prompt' }],
  maxOutputTokens: 256,
};

const runtime = 'https://bedrock-runtime.eu-central-1.amazonaws.com';

const control = 'https://bedrock.eu-central-1.amazonaws.com';

const clock = { now: Date.parse('2026-09-28T12:00:00Z') };

function converse(stopReason: string, content: unknown[]) {
  return {
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  };
}

function profile(...regions: string[]) {
  return {
    inferenceProfileId: model,
    type: 'SYSTEM_DEFINED',
    status: 'ACTIVE',
    models: regions.map((region) => ({
      modelArn: `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
    })),
  };
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

/** Stubs the Bedrock control plane and runtime; defaults pass every check. */
function stub(
  handlers: {
    retention?: Handler;
    logging?: Handler;
    profile?: Handler;
    converse?: Handler;
  } = {},
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === `${control}/data-retention`)
      return (
        handlers.retention ??
        (() =>
          Response.json({
            mode: 'none',
            updatedAt: '2026-06-07T20:19:44.723Z',
          }))
      )(init);
    if (target === `${control}/logging/modelinvocations`)
      return (handlers.logging ?? (() => Response.json({})))(init);
    if (target.startsWith(`${control}/inference-profiles/`))
      return (
        handlers.profile ??
        (() => Response.json(profile('eu-central-1', 'eu-west-1', 'eu-west-3')))
      )(init);
    if (target.startsWith(`${runtime}/model/`))
      return (
        handlers.converse ??
        (() =>
          Response.json(converse('end_turn', [{ text: 'synthetic-response' }])))
      )(init);
    throw new Error('Unexpected destination');
  });
}

function create(
  transport: typeof fetch,
  settings: {
    dataRegion?: 'EU' | 'AU' | 'US';
    region?: string;
    verificationIntervalMs?: number;
  } = {},
) {
  return createBedrockModelAdapter(
    {
      region: 'eu-central-1',
      dataRegion: 'EU',
      credentials,
      timeoutMs: 1000,
      ...settings,
    },
    transport,
    () => clock.now,
  );
}

const urls = (transport: ReturnType<typeof stub>) =>
  transport.mock.calls.map(([url]) => String(url));

const sentBody = (transport: ReturnType<typeof stub>) =>
  JSON.parse(String(transport.mock.calls.at(-1)?.[1]?.body));

describe('Bedrock EU adapter configuration', () => {
  it.each(bedrockRegionalAwsRegions.EU)(
    'accepts the EU region %s',
    (region) => {
      expect(create(stub(), { region })).toMatchObject({
        region: 'EU',
        supportsZeroDataRetention: true,
      });
    },
  );

  it.each([
    'eu-west-2',
    'eu-central-2',
    'us-east-1',
    'EU-CENTRAL-1',
    'eu-central-1.example.com',
    '',
  ])('rejects the non-EU region %j at construction', (region) => {
    expect(() => create(stub(), { region })).toThrow(
      'Bedrock region must match the cell jurisdiction',
    );
  });

  it('rejects missing credentials without echoing them', () => {
    expect(() =>
      createBedrockModelAdapter(
        {
          region: 'eu-central-1',
          credentials: { ...credentials, secretAccessKey: '' },
          timeoutMs: 1000,
        },
        stub(),
      ),
    ).toThrow(/^Bedrock credentials are required$/);
  });
});

describe('Bedrock EU adapter requests', () => {
  it('signs pinned EU requests and checks retention and routing before inference', async () => {
    const transport = stub({
      converse: () =>
        Response.json(
          converse('tool_use', [
            {
              toolUse: {
                toolUseId: 'tooluse_1',
                name: 'answer',
                input: { answer: 'synthetic-response' },
              },
            },
          ]),
        ),
    });
    const result = await create(transport).generate(route, {
      ...request,
      output: answer,
    });
    expect(result).toEqual({
      text: '{"answer":"synthetic-response"}',
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 4, costUsd: null },
    });
    expect(urls(transport)).toEqual([
      `${control}/data-retention`,
      `${control}/logging/modelinvocations`,
      `${control}/inference-profiles/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0`,
      `${runtime}/model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse`,
    ]);
    for (const [url, init] of transport.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(init?.redirect).toBe('error');
      expect(headers).not.toHaveProperty('host');
      expect(headers['x-amz-date']).toBe('20260928T120000Z');
      expect(headers['x-amz-security-token']).toBe(credentials.sessionToken);
      expect(headers['x-amz-content-sha256']).toBe(
        createHash('sha256')
          .update(String(init?.body ?? ''))
          .digest('hex'),
      );
      expect(headers.authorization).toMatch(
        new RegExp(
          `^AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/20260928/eu-central-1/bedrock/aws4_request, SignedHeaders=${
            String(url).startsWith(runtime) ? 'content-type;' : ''
          }host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$`,
        ),
      );
    }
    expect(transport.mock.calls.at(-1)?.[1]?.method).toBe('POST');
    expect(sentBody(transport)).toEqual({
      messages: [{ role: 'user', content: [{ text: 'synthetic-prompt' }] }],
      inferenceConfig: { maxTokens: 256 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'answer',
              description: 'Return the final response in this structure.',
              inputSchema: { json: answer.jsonSchema },
            },
          },
        ],
        toolChoice: { tool: { name: 'answer' } },
      },
    });
  });

  it('skips the profile lookup for an in-region foundation model', async () => {
    const transport = stub();
    await create(transport).generate(
      { ...route, model: 'anthropic.claude-3-haiku-20240307-v1:0' },
      request,
    );
    expect(urls(transport)).toEqual([
      `${control}/data-retention`,
      `${control}/logging/modelinvocations`,
      `${runtime}/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse`,
    ]);
  });

  it.each([
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0',
    'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'ca.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'eu.us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/a1b2c3',
    'eu.model',
    'us.model',
  ])('denies %s before any network call', async (denied) => {
    const transport = stub();
    await expect(
      create(transport).generate({ ...route, model: denied }, request),
    ).rejects.toMatchObject({ code: 'route_denied' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['London', profile('eu-central-1', 'eu-west-2')],
    ['Zurich', profile('eu-central-1', 'eu-central-2')],
    ['the US', profile('eu-central-1', 'us-east-1')],
    [
      'another partition',
      {
        models: [
          {
            modelArn:
              'arn:aws-us-gov:bedrock:eu-central-1::foundation-model/a.b',
          },
        ],
      },
    ],
  ])(
    'denies an EU profile that can route to %s',
    async (_name, destinations) => {
      const transport = stub({ profile: () => Response.json(destinations) });
      await expect(
        create(transport).generate(route, request),
      ).rejects.toMatchObject({ code: 'route_denied' });
      expect(urls(transport).some((url) => url.startsWith(runtime))).toBe(
        false,
      );
    },
  );

  it.each([
    [
      'text logging to S3',
      { s3Config: { bucketName: 'b' }, textDataDeliveryEnabled: true },
    ],
    ['text logging by default', { cloudWatchConfig: { logGroupName: 'g' } }],
    [
      'image logging',
      { textDataDeliveryEnabled: false, imageDataDeliveryEnabled: true },
    ],
    [
      'video logging',
      { textDataDeliveryEnabled: false, videoDataDeliveryEnabled: true },
    ],
    [
      'an unknown payload type',
      { textDataDeliveryEnabled: false, audioDataDeliveryEnabled: true },
    ],
    ['a malformed configuration', 'enabled'],
  ])('fails closed when invocation logging has %s', async (_name, config) => {
    const transport = stub({
      logging: () => Response.json({ loggingConfig: config }),
    });
    await expect(
      create(transport).generate(route, request),
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });
    expect(urls(transport)).toEqual([
      `${control}/data-retention`,
      `${control}/logging/modelinvocations`,
    ]);
  });

  it('allows metadata-only invocation logging', async () => {
    const transport = stub({
      logging: () =>
        Response.json({
          loggingConfig: {
            s3Config: { bucketName: 'bucket' },
            textDataDeliveryEnabled: false,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false,
          },
        }),
    });
    await expect(
      create(transport).generate(route, request),
    ).resolves.toMatchObject({ text: 'synthetic-response' });
  });

  it.each([
    'default',
    'inherit',
    'aws_review',
    'provider_data_share',
    'NONE',
    undefined,
  ])('fails closed when the account retention mode is %s', async (mode) => {
    const transport = stub({ retention: () => Response.json({ mode }) });
    await expect(
      create(transport).generate(route, request),
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });
    expect(urls(transport)).toEqual([`${control}/data-retention`]);
  });

  const checkFailures: [string, Handler][] = [
    ['access denied', () => new Response('synthetic-error', { status: 403 })],
    ['a server error', () => new Response('synthetic-error', { status: 500 })],
    ['a malformed body', () => new Response('synthetic-error')],
    [
      'a redirect',
      () => {
        throw new TypeError('fetch failed: redirect mode is set to error');
      },
    ],
  ];

  it.each(checkFailures)(
    'fails closed when the retention mode check gets %s',
    async (_name, retention) => {
      const transport = stub({ retention });
      await expect(create(transport).generate(route, request)).rejects.toThrow(
        /^Model generation failed: adapter_unavailable$/,
      );
      expect(urls(transport)).toHaveLength(1);
    },
  );

  it.each(checkFailures)(
    'fails closed when the invocation logging check gets %s',
    async (_name, logging) => {
      const transport = stub({ logging });
      await expect(create(transport).generate(route, request)).rejects.toThrow(
        /^Model generation failed: adapter_unavailable$/,
      );
      expect(urls(transport)).toHaveLength(2);
    },
  );

  it('reuses successful checks for the verification interval only', async () => {
    const transport = stub();
    const adapter = create(transport, { verificationIntervalMs: 60_000 });
    await adapter.generate(route, request);
    await adapter.generate(route, request);
    expect(
      urls(transport).filter((url) => url.startsWith(control)),
    ).toHaveLength(3);
    clock.now += 60_000;
    try {
      await adapter.generate(route, request);
    } finally {
      clock.now -= 60_000;
    }
    expect(
      urls(transport).filter((url) => url.startsWith(control)),
    ).toHaveLength(6);
  });

  it('does not cache a failed retention check', async () => {
    let enabled = true;
    const transport = stub({
      logging: () =>
        Response.json({
          loggingConfig: enabled ? { textDataDeliveryEnabled: true } : null,
        }),
    });
    const adapter = create(transport);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(adapter.generate(route, request)).rejects.toMatchObject({
        code: 'adapter_unavailable',
      });
    enabled = false;
    await expect(adapter.generate(route, request)).resolves.toMatchObject({
      text: 'synthetic-response',
    });
    expect(
      urls(transport).filter((url) => url.endsWith('/modelinvocations')),
    ).toHaveLength(3);
  });

  it('merges roles for Converse and keeps system prompts separate', async () => {
    const transport = stub();
    const lookup = {
      name: 'lookup',
      description: '',
      input: answer as ModelSchema<unknown>,
    };
    const messages: ModelMessage[] = [
      { role: 'system', content: 'Rules.' },
      { role: 'user', content: 'First.' },
      { role: 'user', content: 'Second.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'lookup', arguments: { answer: 'x' } },
          { id: 'call-2', name: 'lookup', arguments: { answer: 'y' } },
        ],
      },
      { role: 'tool', callId: 'call-2', content: 'two' },
      { role: 'tool', callId: 'call-1', content: 'one' },
      { role: 'user', content: 'Continue.' },
      { role: 'assistant', content: 'Done.' },
      { role: 'system', content: 'More rules.' },
      { role: 'user', content: 'Again.' },
    ];
    await create(transport).generate(route, {
      ...request,
      tools: [lookup],
      messages,
    });
    expect(sentBody(transport)).toEqual({
      system: [{ text: 'Rules.' }, { text: 'More rules.' }],
      messages: [
        { role: 'user', content: [{ text: 'First.' }, { text: 'Second.' }] },
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'call-1',
                name: 'lookup',
                input: { answer: 'x' },
              },
            },
            {
              toolUse: {
                toolUseId: 'call-2',
                name: 'lookup',
                input: { answer: 'y' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: { toolUseId: 'call-2', content: [{ text: 'two' }] },
            },
            {
              toolResult: { toolUseId: 'call-1', content: [{ text: 'one' }] },
            },
            { text: 'Continue.' },
          ],
        },
        { role: 'assistant', content: [{ text: 'Done.' }] },
        { role: 'user', content: [{ text: 'Again.' }] },
      ],
      inferenceConfig: { maxTokens: 256 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'lookup',
              inputSchema: { json: answer.jsonSchema },
            },
          },
        ],
        toolChoice: { auto: {} },
      },
    });
  });

  it('requires a tool or the output tool when both are declared', async () => {
    const transport = stub();
    const lookup = { name: 'lookup', description: 'Read', input: answer };
    await expect(
      create(transport).generate(route, {
        ...request,
        output: answer,
        tools: [lookup],
      }),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    expect(sentBody(transport).toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'lookup',
            description: 'Read',
            inputSchema: { json: answer.jsonSchema },
          },
        },
        {
          toolSpec: {
            name: 'answer',
            description: 'Return the final response in this structure.',
            inputSchema: { json: answer.jsonSchema },
          },
        },
      ],
      toolChoice: { any: {} },
    });
  });

  it('rejects an output name that collides with a tool before any network call', async () => {
    const transport = stub();
    await expect(
      create(transport).generate(route, {
        ...request,
        output: answer,
        tools: [{ name: 'answer', description: '', input: answer }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('treats a throttling error type as rate limiting without reading the body', async () => {
    const cancel = vi.fn();
    const transport = stub({
      converse: () =>
        new Response(
          new ReadableStream({
            pull: () => {
              throw new Error('body must not be read');
            },
            cancel,
          }),
          {
            status: 400,
            headers: {
              'x-amzn-ErrorType':
                'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/',
            },
          },
        ),
    });
    await expect(
      create(transport).generate(route, request),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects a redirected inference request', async () => {
    const transport = stub({
      converse: (init) => {
        if (init?.redirect === 'error') throw new TypeError('fetch failed');

        return Response.json(converse('end_turn', [{ text: 'redirected' }]));
      },
    });
    await expect(
      create(transport).generate(route, request),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('authoring route through the model gateway', () => {
  const shutdown: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(shutdown.splice(0).map((close) => close()));
  });

  function setup(
    transport: typeof fetch,
    settings: { installed?: boolean; route?: Partial<ModelRoute> } = {},
  ) {
    const spans = new InMemorySpanExporter();
    const telemetry = createObservability(
      {
        environment: 'test',
        release: 'test',
        sampleRate: 1,
        approvedModels: [model],
      },
      { spanProcessors: [new SimpleSpanProcessor(spans)] },
    );
    shutdown.push(() => telemetry.shutdown());
    const gateway = createRoutedModelGateway(
      { [authoringModelProfile]: { ...route, ...settings.route } },
      settings.installed === false ? {} : { bedrock: create(transport) },
      telemetry,
      () => clock.now,
    );
    const root = telemetry.request('00000000-0000-4000-8000-000000000002');
    const exported = () =>
      JSON.stringify(
        spans
          .getFinishedSpans()
          .map((span) => [span.attributes, span.events, span.status]),
      );

    return { gateway, root, exported };
  }

  it('serves sensitive EU authoring requests with zero retention', async () => {
    const transport = stub({
      converse: () =>
        Response.json(
          converse('tool_use', [
            {
              toolUse: {
                toolUseId: 'tooluse_1',
                name: 'answer',
                input: { answer: 'synthetic-response' },
              },
            },
          ]),
        ),
    });
    const { gateway, root, exported } = setup(transport);
    const result = await gateway.generate(root.context, {
      ...request,
      output: answer,
    });
    expect(result.output).toEqual({ answer: 'synthetic-response' });
    expect(result.metadata).toMatchObject({ adapter: 'bedrock', model });
    root.end();
    expect(exported()).toContain(model);
    expect(exported()).not.toMatch(/synthetic|bedrock-secret|bedrock-session/);
  });

  it('fails closed when the Bedrock route is not installed', async () => {
    const transport = stub();
    const { gateway, root } = setup(transport, { installed: false });
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code: 'adapter_unavailable' },
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<ModelRoute>, string]>([
    ['retention disabled', { zeroDataRetention: false }, 'route_denied'],
    [
      'a global profile',
      { model: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' },
      'route_denied',
    ],
    ['the Vercel adapter', { adapter: 'vercel' }, 'adapter_unavailable'],
  ])('fails closed for a route with %s', async (_name, override, code) => {
    const transport = stub();
    const { gateway, root } = setup(transport, { route: override });
    await expect(gateway.generate(root.context, request)).rejects.toMatchObject(
      { code },
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails closed without sending the prompt when invocation logging is on', async () => {
    const transport = stub({
      logging: () =>
        Response.json({ loggingConfig: { textDataDeliveryEnabled: true } }),
    });
    const { gateway, root, exported } = setup(transport);
    await expect(gateway.generate(root.context, request)).rejects.toThrow(
      /^Model generation failed: adapter_unavailable$/,
    );
    expect(
      transport.mock.calls.some(([, init]) =>
        String(init?.body ?? '').includes('synthetic'),
      ),
    ).toBe(false);
    root.end();
    expect(exported()).not.toMatch(/synthetic/);
  });
});
