import { readFile } from 'node:fs/promises';

import { expect, it, vi } from 'vitest';

import {
  createApiClient,
  subscribeToCaseProgress,
  subscribeToMetrics,
} from './client.js';
import { dataRegionSchema, organizationParamsSchema } from './index.js';
import { openApiDocument } from './openapi.js';

it('keeps the committed SDK document synchronized with the contract', async () => {
  const committed = JSON.parse(
    await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
  );
  expect(committed).toEqual(openApiDocument);
});

it('generates concrete response, parameter and error schemas with unique operation IDs', () => {
  const document = JSON.parse(JSON.stringify(openApiDocument));
  const get = document.paths['/v1/connector-providers/{providerId}'].get;
  expect(get.parameters).toContainEqual(
    expect.objectContaining({
      name: 'providerId',
      in: 'path',
      required: true,
      schema: expect.objectContaining({ type: 'string', maxLength: 64 }),
    }),
  );
  expect(
    get.responses['200'].content['application/json'].schema.properties.category
      .enum,
  ).toEqual(['storefront', 'erp']);
  expect(
    get.responses['404'].content['application/json'].schema.required,
  ).toEqual(['code', 'message', 'requestId']);
  const ids = Object.values(document.paths).flatMap((path) =>
    Object.values(path as Record<string, { operationId: string }>).map(
      (operation) => operation.operationId,
    ),
  );
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it('preserves organization and reserved region transport conventions', () => {
  expect(dataRegionSchema.options).toEqual(['EU', 'US', 'APAC']);
  expect(
    organizationParamsSchema.safeParse({ organizationId: 'invalid' }).success,
  ).toBe(false);
});

it('throws on undocumented statuses instead of asserting a false response type', async () => {
  const client = createApiClient({
    baseUrl: 'http://unused',
    api: async () => ({ status: 418, body: {}, headers: new Headers() }),
  });
  await expect(
    client.connectorProviders.get({ params: { providerId: 'shopify' } }),
  ).rejects.toThrow();
});

it('documents bounded tenant-scoped case evidence and validates its query', async () => {
  const { caseEvidenceQuerySchema } = await import('./cases.js');
  expect(caseEvidenceQuerySchema.parse({})).toEqual({ limit: 25 });
  for (const query of [
    { limit: 101 },
    { limit: 0 },
    { limit: 1.5 },
    { cursor: '' },
    { extra: true },
  ])
    expect(caseEvidenceQuerySchema.safeParse(query).success).toBe(false);
  const document = JSON.parse(JSON.stringify(openApiDocument));
  const operation =
    document.paths[
      '/v1/organizations/{organizationId}/exceptions/{exceptionId}/evidence'
    ].get;
  expect(operation.operationId).toBe('exceptions.evidence');
  expect(operation.responses).toHaveProperty('401');
  expect(operation.responses).toHaveProperty('404');
  expect(
    operation.responses['200'].content['application/json'].schema.properties
      .items.maxItems,
  ).toBe(100);
});

it('documents decision conflicts and authenticated resync streams', () => {
  const document = JSON.parse(JSON.stringify(openApiDocument));
  const base = '/v1/organizations/{organizationId}/exceptions/{exceptionId}';
  expect(document.paths[`${base}/decisions`].post.responses).toHaveProperty(
    '409',
  );
  expect(
    document.paths[`${base}/events`].get.responses['200'].content,
  ).toHaveProperty('text/event-stream');
  expect(document.paths[`${base}/events`].get.responses).toHaveProperty('401');
  expect(document.paths[`${base}/events`].get.responses).toHaveProperty('429');
});

it('validates SSE snapshots and closes malformed streams while allowing transport reconnects', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const close = vi.fn();
  const create = vi.fn();
  vi.stubGlobal(
    'EventSource',
    class {
      constructor(url: string, options: unknown) {
        create(url, options);
      }
      addEventListener(name: string, callback: (event: unknown) => void) {
        listeners.set(name, callback);
      }
      close = close;
    },
  );
  try {
    const onResync = vi.fn(),
      onError = vi.fn();
    const stop = subscribeToCaseProgress({
      baseUrl: 'https://luma.example/api/',
      organizationId: 'org',
      exceptionId: '11111111-1111-4111-8111-111111111111',
      onResync,
      onError,
    });
    expect(create).toHaveBeenCalledWith(
      'https://luma.example/api/v1/organizations/org/exceptions/11111111-1111-4111-8111-111111111111/events',
      { withCredentials: true },
    );
    listeners.get('error')!({});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    const progress = {
      schemaVersion: 1,
      caseRevision: 1,
      state: 'detected',
      diagnosisRevision: 0,
      execution: null,
      resolution: null,
      workflow: { availability: 'unavailable', progress: null },
    };
    listeners.get('resync')!({
      data: JSON.stringify({
        schemaVersion: 1,
        exceptionId: '11111111-1111-4111-8111-111111111111',
        refetch: true,
        progress,
      }),
    });
    expect(onResync).toHaveBeenCalledWith(progress);
    listeners.get('resync')!({
      data: JSON.stringify({
        schemaVersion: 1,
        exceptionId: '22222222-2222-4222-8222-222222222222',
        refetch: true,
        progress,
      }),
    });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockClear();
    onError.mockClear();
    listeners.get('resync')!({ data: 'invalid' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('validates metric scope and leaves network errors reconnectable', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const close = vi.fn();
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener(name: string, callback: (event: unknown) => void) {
        listeners.set(name, callback);
      }
      close = close;
    },
  );
  try {
    const onResync = vi.fn();
    const onError = vi.fn();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const stop = subscribeToMetrics({
      baseUrl: '/api',
      organizationId,
      onResync,
      onError,
    });
    const event = {
      schemaVersion: 1,
      organizationId,
      scope: 'order-metrics',
      connected: true,
      refetch: true,
      sentAt: '2026-09-28T00:00:00.000Z',
    };
    listeners.get('resync')!({ data: JSON.stringify(event) });
    expect(onResync).toHaveBeenCalledWith(event);
    listeners.get('error')!({});
    expect(close).not.toHaveBeenCalled();
    listeners.get('resync')!({
      data: JSON.stringify({
        ...event,
        organizationId: '22222222-2222-4222-8222-222222222222',
      }),
    });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(2);
    stop();
  } finally {
    vi.unstubAllGlobals();
  }
});
