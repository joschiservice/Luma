import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Writable } from 'node:stream';

import { apiErrorSchema } from '@luma/api-contract';
import { createApiClient } from '@luma/api-contract/client';
import { openApiDocument } from '@luma/api-contract/openapi';
import { buildApp } from '@luma/application-runtime';
import { createProviderCatalog } from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import { createObservability } from '@luma/platform/composition';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('HTTP foundation', () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  function createApp(...args: Parameters<typeof buildApp>) {
    const app = buildApp(...args);
    apps.push(app);

    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('serves liveness, readiness and the generated OpenAPI document', async () => {
    const app = createApp();
    for (const [url, body] of [
      ['/health', { status: 'ok' }],
      ['/ready', { status: 'ready' }],
      ['/openapi.json', openApiDocument],
    ] as const) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(body);
    }
    const head = await app.inject({ method: 'HEAD', url: '/health' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('consumes a real HTTP server through the typed client', async () => {
    const app = createApp(
      {},
      {
        providerCatalog: createProviderCatalog([
          { id: 'shopify', name: 'Shopify', category: 'storefront' },
          { id: 'jtl', name: 'JTL', category: 'erp' },
        ]),
      },
    );
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createApiClient({ baseUrl });
    expect(
      await client.connectorProviders.get({
        params: { providerId: 'shopify' },
      }),
    ).toEqual({ id: 'shopify', name: 'Shopify', category: 'storefront' });
    expect(
      await client.connectorProviders.list({ query: { category: 'erp' } }),
    ).toEqual({ items: [{ id: 'jtl', name: 'JTL', category: 'erp' }] });
    await expect(
      client.connectorProviders.get({ params: { providerId: 'missing' } }),
    ).rejects.toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Provider not found' },
    });
  });

  it.each([
    '/v1/connector-providers/INVALID',
    '/v1/connector-providers?category=invalid',
    '/v1/connector-providers?organizationId=forged',
    '/v1/connector-providers?category=erp&category=storefront',
  ])('rejects invalid input: %s', async (url) => {
    const response = await createApp().inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      requestId: response.headers['x-request-id'],
    });
  });

  it('normalizes missing routes and does not expose tenant endpoints', async () => {
    const response = await createApp().inject(
      '/v1/organizations/forged/unknown-resource',
    );
    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).code).toBe('NOT_FOUND');
  });

  it.each([
    async () => false,
    async () => {
      throw new Error('secret dependency details');
    },
    () => new Promise<boolean>(() => {}),
  ])(
    'returns 503 when readiness fails or times out, while liveness stays healthy',
    async (checkReadiness) => {
      const app = createApp({}, { checkReadiness, readinessTimeoutMs: 10 });
      const ready = await app.inject('/ready');
      expect(ready.statusCode).toBe(503);
      expect(apiErrorSchema.parse(ready.json()).code).toBe('NOT_READY');
      expect(ready.body).not.toContain('secret');
      expect((await app.inject('/health')).statusCode).toBe(200);
    },
  );

  it('sanitizes unexpected errors', async () => {
    const app = createApp();
    app.addHook('preHandler', async () => {
      throw new Error('secret database details');
    });
    const response = await app.inject('/v1/connector-providers');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: response.headers['x-request-id'],
    });
  });

  it('validates handler responses and hides invalid output', async () => {
    const app = createApp(
      {},
      {
        providerCatalog: {
          list: () => [],
          get: () => ({ id: 'shopify', name: '', category: 'storefront' }),
        },
      },
    );
    const response = await app.inject('/v1/connector-providers/shopify');
    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('Zod');
  });

  it.each([
    {
      payload: '{',
      headers: { 'content-type': 'application/json' },
      status: 400,
      code: 'VALIDATION_ERROR',
    },
    {
      payload: 'x',
      headers: { 'content-type': 'application/unsupported' },
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    },
    {
      payload: JSON.stringify({ value: 'x'.repeat(100) }),
      headers: { 'content-type': 'application/json' },
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    },
  ])(
    'normalizes parser errors ($status)',
    async ({ payload, headers, status, code }) => {
      const app = createApp({ bodyLimit: 50 });
      app.post('/test-parser', async () => ({}));
      const response = await app.inject({
        method: 'POST',
        url: '/test-parser',
        payload,
        headers,
      });
      expect(response.statusCode).toBe(status);
      expect(apiErrorSchema.parse(response.json()).code).toBe(code);
    },
  );
});

it('protects newly registered routes when no identity service is configured', async () => {
  const app = buildApp();
  app.get('/v1/private', async () => ({ secret: 'must not leak' }));
  app.post('/health', async () => ({ secret: 'must not leak' }));
  for (const [method, url] of [
    ['GET', '/v1/private'],
    ['POST', '/health'],
  ] as const) {
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('must not leak');
  }
  await app.close();
});

// Staging evaluates flags through the PostHog mock; development and test never call it.
const settings = {
  environment: 'staging' as const,
  release: 'test',
  sampleRate: 1,
  tenantHashKey: 'a'.repeat(32),
};

function fixture() {
  const spans = new InMemorySpanExporter();
  // Keep collected spans available after the application's shutdown hook.
  spans.shutdown = async () => {};
  const posthog = {
    capture: vi.fn(),
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const observability = createObservability(settings, {
    spanProcessors: [new SimpleSpanProcessor(spans)],
    posthog,
  });
  const identity: IdentityService = {
    resolveWorkflowContext: vi.fn(),
    refreshContext: vi.fn(async (context) => context),
    authenticate: vi.fn(),
    listSecurityEvents: vi.fn(),
    setLanguage: vi.fn(),
    listOrganizations: vi.fn(),
    createOrganization: vi.fn(),
    listMembers: vi.fn(),
    suspendedMembers: vi.fn(),
    changeMember: vi.fn(),
    hasSupportView: vi.fn(() => false),
    supportView: vi.fn(),
    redeemSupportView: vi.fn(),
    endSupportView: vi.fn(),
    sweepSupportViews: vi.fn(),
    resolveTenant: vi.fn(async (credentials, tenantId, requestId) => {
      if (!credentials.cookie)
        throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

      return makeTenantContext(
        { userId: 'private-user', sessionId: 'private-session' },
        {
          id: tenantId,
          name: 'Workspace',
          slug: 'workspace',
          dataRegion: 'EU',
          status: 'active',
        },
        builtInMembership(
          {
            id: 'private-membership',
            organizationId: tenantId,
            userId: 'private-user',
          },
          'owner',
        ),
        requestId,
      );
    }),
  };

  return { spans, posthog, observability, identity };
}

describe('observability baseline', () => {
  it('correlates a user action through HTTP, workflow, agent, model and tool without exporting payloads', async () => {
    const { spans, posthog, observability, identity } = fixture();
    const actionId = randomUUID();
    const app = buildApp(
      {},
      { observability, identity, trustedOrigins: ['http://localhost:3000'] },
    );
    app.post(
      '/v1/organizations/:organizationId/test-operation',
      { config: { access: { access: 'member' } } },
      async (request) => {
        const parent = request.observation!.context;
        expect(parent.tenantRef).toMatch(/^[a-f0-9]{64}$/);
        await observability.run(parent, 'workflow.run', async (workflow) =>
          observability.run(workflow, 'agent.run', async (agent) => {
            await observability.run(
              agent,
              'model.generate',
              async (_context, generation) => {
                generation.generation({
                  model: 'test-model',
                  inputTokens: 12,
                  outputTokens: 4,
                });

                return { output: 'private model output' };
              },
            );
            await observability.run(agent, 'tool.execute', async () => ({
              payload: request.body,
            }));
          }),
        );
        expect(await observability.flag(parent, 'observability-test')).toBe(
          true,
        );
        observability.capture(parent, 'observability_test_completed');

        return { ok: true };
      },
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations/11111111-1111-4111-8111-111111111111/test-operation?secret=query-secret',
        headers: {
          'x-luma-action-id': actionId,
          authorization: 'Bearer credential-secret',
          origin: 'http://localhost:3000',
          cookie: 'session=cookie-secret',
          'x-tenant-id': 'forged-tenant',
        },
        payload: {
          email: 'private@example.com',
          prompt: 'private prompt',
          password: 'password-secret',
        },
      });
      expect(response.statusCode).toBe(200);
      const records = spans.getFinishedSpans();
      expect(records).toHaveLength(5);
      expect(
        new Set(records.map((span) => span.spanContext().traceId)),
      ).toEqual(new Set([response.headers['x-trace-id']]));
      const root = records.find((span) => span.name === 'api.request')!;
      const workflow = records.find((span) => span.name === 'workflow.run')!;
      const agent = records.find((span) => span.name === 'agent.run')!;
      expect(workflow.parentSpanContext?.spanId).toBe(
        root.spanContext().spanId,
      );
      expect(agent.parentSpanContext?.spanId).toBe(
        workflow.spanContext().spanId,
      );
      for (const record of records) {
        expect(record.attributes.action_id).toBe(actionId);
        expect(record.attributes.tenant_ref).toMatch(/^[a-f0-9]{64}$/);
        expect(record.attributes.request_id).toBe(
          response.headers['x-request-id'],
        );
        if (['model.generate', 'tool.execute'].includes(record.name))
          expect(record.parentSpanContext?.spanId).toBe(
            agent.spanContext().spanId,
          );
      }
      expect(
        records.find((span) => span.name === 'model.generate')?.attributes,
      ).toMatchObject({
        'langfuse.observation.type': 'generation',
        'langfuse.observation.model.name': 'test-model',
        'langfuse.observation.usage_details': '{"input":12,"output":4}',
      });
      expect(posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'observability_test_completed',
          properties: expect.objectContaining({
            action_id: actionId,
            trace_id: response.headers['x-trace-id'],
            $process_person_profile: false,
          }),
        }),
      );
      const serialized = JSON.stringify([
        records.map((span) => ({
          name: span.name,
          attributes: span.attributes,
          events: span.events,
        })),
        posthog.capture.mock.calls,
        posthog.isFeatureEnabled.mock.calls,
      ]);
      for (const secret of [
        'private',
        'secret',
        'forged-tenant',
        '11111111-1111-4111-8111-111111111111',
        'Bearer',
      ])
        expect(serialized).not.toContain(secret);
    } finally {
      await app.close();
    }
    expect(posthog.shutdown).toHaveBeenCalledOnce();
  });

  it('isolates concurrent tenants and requests, rejecting client request IDs and malformed action IDs', async () => {
    const { spans, observability, identity } = fixture();
    const app = buildApp({}, { observability, identity });
    app.get(
      '/v1/organizations/:organizationId/concurrent',
      { config: { access: { access: 'member' } } },
      async (request) => {
        const context = request.observation!.context;
        await observability.run(context, 'workflow.run', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });

        return {};
      },
    );
    try {
      const responses = await Promise.all(
        [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ].map((tenant) =>
          app.inject({
            url: `/v1/organizations/${tenant}/concurrent`,
            headers: {
              cookie: 'session=private-session',
              'x-request-id': 'private@example.com',
              'x-luma-action-id': 'private@example.com',
            },
          }),
        ),
      );
      expect(responses[0]!.headers['x-request-id']).not.toBe(
        responses[1]!.headers['x-request-id'],
      );
      const workflows = spans
        .getFinishedSpans()
        .filter((span) => span.name === 'workflow.run');
      expect(
        new Set(workflows.map((span) => span.attributes.tenant_ref)).size,
      ).toBe(2);
      expect(
        new Set(workflows.map((span) => span.spanContext().traceId)).size,
      ).toBe(2);
      expect(
        JSON.stringify(workflows.map((span) => span.attributes)),
      ).not.toContain('private@example.com');
    } finally {
      await app.close();
    }
  });

  it('does not attach tenant metadata when authorization fails', async () => {
    const { observability, identity, spans } = fixture();
    const app = buildApp({}, { observability, identity });
    try {
      const response = await app.inject({
        url: '/v1/organizations/11111111-1111-4111-8111-111111111111/context',
        headers: { 'x-tenant-id': 'forged-tenant' },
      });
      expect(response.statusCode).toBe(401);
      expect(spans.getFinishedSpans()).toHaveLength(1);
      expect(
        spans.getFinishedSpans()[0]!.attributes.tenant_ref,
      ).toBeUndefined();
      expect(
        JSON.stringify(spans.getFinishedSpans()[0]!.attributes),
      ).not.toContain('11111111-1111-4111-8111-111111111111');
    } finally {
      await app.close();
    }
  });

  it('keeps analytics failures and flag outages out of business results', async () => {
    const { observability, posthog } = fixture();
    const root = observability.request(randomUUID());
    posthog.capture.mockImplementation(() => {
      throw new Error('secret');
    });
    posthog.isFeatureEnabled.mockRejectedValue(new Error('secret'));
    expect(() =>
      observability.capture(root.context, 'observability_test_completed'),
    ).not.toThrow();
    expect(await observability.flag(root.context, 'observability-test')).toBe(
      false,
    );
    expect(
      await observability.flag(root.context, 'observability-test', true),
    ).toBe(true);
    expect(() =>
      observability.forTenant(root.context, 'tenant', 'US' as 'EU'),
    ).toThrow();
    root.end();
    await observability.shutdown();
  });

  it('hides unexpected errors from clients and logs their details with the route', async () => {
    const { observability, spans } = fixture();
    let log = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        log += chunk.toString();
        done();
      },
    });
    const app = buildApp({ logger: { stream } }, { observability });
    app.addHook('preHandler', async () => {
      throw Object.assign(new Error('Overview query timed out'), {
        code: '57014',
        detail: 'private@example.com',
      });
    });
    try {
      const response = await app.inject({
        url: '/health?token=query-secret',
        headers: { cookie: 'session=cookie-secret' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('Overview query timed out');
      expect(spans.getFinishedSpans()[0]?.status.code).toBe(2);
      const entry = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { msg: string })
        .find((line) => line.msg === 'Request failed');
      expect(entry).toMatchObject({
        msg: 'Request failed',
        traceId: response.headers['x-trace-id'],
        method: 'GET',
        route: '/health',
        error: {
          type: 'Error',
          message: 'Overview query timed out',
          code: '57014',
          stack: expect.stringContaining('app.test.ts'),
        },
      });
      expect(log).not.toMatch(/private|cookie-secret|query-secret/);
    } finally {
      await app.close();
    }
  });

  it('records the catalog action through the real typed HTTP client', async () => {
    const { observability, posthog } = fixture();
    const app = buildApp(
      {},
      {
        observability,
        providerCatalog: createProviderCatalog([
          { id: 'shopify', name: 'Shopify', category: 'storefront' },
        ]),
      },
    );
    try {
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const actionId = randomUUID();
      await createApiClient({ baseUrl }).connectorProviders.get(
        { params: { providerId: 'shopify' } },
        { context: { headers: { 'x-luma-action-id': actionId } } },
      );
      expect(posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'connector_provider_viewed',
          properties: expect.objectContaining({ action_id: actionId }),
        }),
      );
    } finally {
      await app.close();
    }
  });
});

it('composes model-backed work with routes selected by startup configuration', async () => {
  const { readModelGatewayConfig } = await import('@luma/config');
  const { createModelGateway } = await import('@luma/platform/composition');
  for (const [model, provider] of [
    ['anthropic/claude-sonnet-4.5', 'anthropic'],
    ['openai/gpt-4.1', 'openai'],
  ]) {
    const settings = readModelGatewayConfig({
      AI_GATEWAY_API_KEY: 'test-key',
      MODEL_GATEWAY_ROUTES: JSON.stringify({
        reasoning: {
          adapter: 'vercel',
          model,
          providers: [provider],
          zeroDataRetention: true,
        },
      }),
    });
    const observability = createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 1,
      approvedModels: [model!],
    });
    const models: string[] = [];
    const gateway = createModelGateway(settings, observability, {
      transport: async (_url, init) => {
        models.push(JSON.parse(String(init?.body)).model);

        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: 'summary' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    const app = buildApp({}, { modelGateway: gateway, observability });
    try {
      const root = observability.request(randomUUID());
      const output = await observability.run(
        root.context,
        'workflow.run',
        async (context) =>
          app.modelGateway!.generate(context, {
            profile: 'reasoning',
            dataPolicy: {
              classification: 'public',
              region: 'unrestricted',
              zeroDataRetention: true,
            },
            messages: [
              { role: 'user', content: 'Summarize this synthetic fixture.' },
            ],
            maxOutputTokens: 64,
          }),
      );
      expect(output.output).toBe('summary');
      expect(models).toEqual([model]);
      root.end();
    } finally {
      await app.close();
    }
  }
});

it('composes the EU authoring route from startup configuration', async () => {
  const { readModelGatewayConfig } = await import('@luma/config');
  const { authoringModelProfile } = await import('@luma/platform');
  const { createModelGateway } = await import('@luma/platform/composition');
  const model = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
  const env = {
    MODEL_GATEWAY_ROUTES: JSON.stringify({
      [authoringModelProfile]: {
        adapter: 'bedrock-eu',
        model,
        providers: ['bedrock'],
        zeroDataRetention: true,
      },
    }),
    MODEL_GATEWAY_BEDROCK_REGION: 'eu-central-1',
    MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: 'AKIAEXAMPLERUNTIME01',
    MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: 'runtime-secret-access-key',
  };
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 1,
    approvedModels: [model],
  });
  const destinations: string[] = [];
  const gateway = createModelGateway(
    readModelGatewayConfig(env),
    observability,
    {
      transport: async (url) => {
        const target = new URL(String(url));
        destinations.push(`${target.host}${target.pathname}`);
        if (target.pathname === '/data-retention')
          return Response.json({ mode: 'none' });
        if (target.pathname === '/logging/modelinvocations')
          return Response.json({});
        if (target.pathname.startsWith('/inference-profiles/'))
          return Response.json({
            models: [
              {
                modelArn:
                  'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
              },
            ],
          });

        return Response.json({
          output: {
            message: { role: 'assistant', content: [{ text: 'draft' }] },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      },
    },
  );
  const root = observability.request(randomUUID());
  const result = await gateway.generate(root.context, {
    profile: authoringModelProfile,
    dataPolicy: {
      classification: 'sensitive',
      region: 'EU',
      zeroDataRetention: true,
    },
    messages: [{ role: 'user', content: 'Describe a synthetic workflow.' }],
    maxOutputTokens: 64,
  });
  root.end();
  expect(result.output).toBe('draft');
  expect(destinations).toEqual([
    'bedrock.eu-central-1.amazonaws.com/data-retention',
    'bedrock.eu-central-1.amazonaws.com/logging/modelinvocations',
    'bedrock.eu-central-1.amazonaws.com/inference-profiles/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0',
    'bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse',
  ]);

  const unconfigured = createModelGateway(
    readModelGatewayConfig({}),
    observability,
  );
  await expect(
    unconfigured.generate(root.context, {
      profile: authoringModelProfile,
      dataPolicy: {
        classification: 'sensitive',
        region: 'EU',
        zeroDataRetention: true,
      },
      messages: [{ role: 'user', content: 'Describe a synthetic workflow.' }],
      maxOutputTokens: 64,
    }),
  ).rejects.toMatchObject({ code: 'route_denied' });
  expect(() =>
    createModelGateway(
      {
        ...readModelGatewayConfig(env),
        bedrock: {
          region: 'eu-west-2',
          credentials: {
            accessKeyId: 'AKIAEXAMPLERUNTIME01',
            secretAccessKey: 'runtime-secret-access-key',
          },
        },
      },
      observability,
    ),
  ).toThrow('Bedrock region must be an AWS region in the EU');
  expect(() =>
    readModelGatewayConfig({
      ...env,
      MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: undefined,
    }),
  ).toThrow();
  await observability.shutdown();
});

it('closes unused TCP preconnections during shutdown', async () => {
  const app = buildApp();
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const socket = createConnection({
    host: address.hostname,
    port: Number(address.port),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  try {
    await app.close();
  } finally {
    socket.destroy();
  }
}, 2000);
