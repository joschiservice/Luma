import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createApiClient } from './client.js';
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
