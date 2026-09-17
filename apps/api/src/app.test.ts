import { afterEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@luma/api-contract';
import { createApiClient } from '@luma/api-contract/client';
import { openApiDocument } from '@luma/api-contract/openapi';
import { buildApp } from './app.js';

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
  });

  it('consumes a real HTTP server through the typed client', async () => {
    const app = createApp();
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createApiClient({ baseUrl });
    const response = await client.connectorProviders.get({
      params: { providerId: 'shopify' },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) throw new Error('Expected provider');
    expect(response.body).toEqual({
      id: 'shopify',
      name: 'Shopify',
      category: 'storefront',
    });
    const list = await client.connectorProviders.list({
      query: { category: 'erp' },
    });
    expect(list.body).toEqual({
      items: [{ id: 'jtl', name: 'JTL', category: 'erp' }],
    });
    const missing = await client.connectorProviders.get({
      params: { providerId: 'missing' },
    });
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(missing.body).code).toBe('NOT_FOUND');
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
      '/v1/organizations/forged/orders',
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
