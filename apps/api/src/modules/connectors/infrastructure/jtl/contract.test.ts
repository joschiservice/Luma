import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '#modules/identity/index';
import { createJtlConnector } from '#modules/connectors/infrastructure/jtl/adapter';
import { cloudPayload } from '#modules/connectors/infrastructure/jtl/fixtures/cloud';
import {
  shippingMethodState,
  shippingMethodResponse,
} from '#modules/connectors/infrastructure/jtl/shipping-method';
import { API_VERSION } from '#modules/connectors/infrastructure/jtl/client';
import * as s from '#modules/connectors/infrastructure/jtl/schemas';
import api from './fixtures/erp-2.2.json' with { type: 'json' };
import commerce from './fixtures/commerce.json' with { type: 'json' };

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
};
const cloudIdForContract = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000010';
const schemas: Record<string, Schema> = api.schemas;
function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const found = schemas[schema.$ref.split('/').at(-1)!];
  if (!found) throw new Error(`Unknown reference ${schema.$ref}`);
  return found;
}
// Compare the allowlisted projections to the provider's field names and types.
function validate(value: unknown, schema: Schema): void {
  schema = resolve(schema);
  if (value === null || value === undefined) return;
  if (schema.type === 'object') {
    expect(value).toBeTypeOf('object');
    for (const [key, field] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const property = schema.properties?.[key];
      if (!property) throw new Error(`Unknown provider field ${key}`);
      validate(field, property);
    }
  } else if (schema.type === 'array') {
    expect(Array.isArray(value)).toBe(true);
    for (const row of value as unknown[]) validate(row, schema.items!);
  } else if (schema.type === 'number' && schema.format === 'decimal') {
    expect(String(value)).toMatch(/^-?\d+(\.\d+)?$/);
  } else {
    expect(typeof value).toBe(
      schema.type === 'integer' ? 'number' : schema.type,
    );
    if (schema.type === 'integer') expect(Number.isInteger(value)).toBe(true);
    if (schema.type === 'string' && schema.format === 'uuid')
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
  }
}
function response(path: keyof typeof api.paths, list = false): Schema {
  const schema = resolve(api.paths[path].response);
  return list ? resolve(schema.properties?.items ?? schema).items! : schema;
}

describe('JTL 2.2 published contract', () => {
  it.each(['onprem', 'cloud'] as const)(
    'sends a schema-valid UUID shipping method through %s',
    async (kind) => {
      const replacement = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000008';
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        if (init?.method === 'PATCH') {
          validate(
            JSON.parse(String(init.body)),
            api.shippingMethodWrite.request,
          );
          return Response.json({ salesOrderId: cloudIdForContract });
        }
        return Response.json({
          id: cloudIdForContract,
          shippingMethodId: cloudIdForContract,
          isCancelled: false,
        });
      });
      const connector = createJtlConnector({
        tenantId: 'tenant-a',
        connectionId: 'connection-a',
        shippingMethodActions: true,
        recordObservations: async () => {},
        fetch,
        connection:
          kind === 'cloud'
            ? {
                kind: 'cloud',
                jtlTenantId: cloudIdForContract,
                accessToken: async () => 'token',
              }
            : {
                kind: 'onprem',
                baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
                appId: 'Luma',
                appVersion: '0',
                challengeCode: 'challenge',
                apiKey: async () => 'token',
              },
      });
      await connector.capabilities['orders.shipping-method.write']!.run(
        {
          tenant: { tenantId: 'tenant-a' } as TenantContext,
          connectionId: 'connection-a',
          provider: 'jtl',
          idempotencyKey: 'key',
        },
        {
          order: { externalId: cloudIdForContract, scopeKey: '' },
          expectedShippingMethod: {
            externalId: cloudIdForContract,
            scopeKey: '',
          },
          shippingMethod: { externalId: replacement, scopeKey: '' },
        },
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(String(fetch.mock.calls[1]![1]?.body)).shippingMethodId,
      ).toBe(replacement);
      expect(() =>
        validate({ shippingMethodId: 8 }, api.shippingMethodWrite.request),
      ).toThrow();
    },
  );
  it('pins the shipping-method PATCH, authoritative read and provider idempotency header', () => {
    validate(
      shippingMethodState.parse({
        id: cloudIdForContract,
        shippingMethodId: cloudIdForContract,
        isCancelled: false,
      }),
      response('/v2/sales-orders/{salesOrderId}'),
    );
    validate(
      { shippingMethodId: cloudIdForContract, disableAutomaticWorkflows: true },
      api.shippingMethodWrite.request,
    );
    validate(
      shippingMethodResponse.parse({ salesOrderId: cloudIdForContract }),
      api.shippingMethodWrite.response,
    );
    expect(api.shippingMethodWrite.parameters).toContainEqual({
      name: 'Idempotency-Key',
      in: 'header',
    });
    expect(
      api.shippingMethodWrite.parameters.some(
        (p) => p.name.toLowerCase() === 'if-match',
      ),
    ).toBe(false);
  });
  it('pins the schema version and validates the consumed response projections', () => {
    expect(api.version).toBe(API_VERSION);
    validate(
      s.order.parse(cloudPayload(commerce.orders[0])),
      response('/v2/sales-orders', true),
    );
    validate(
      s.orderLine.parse(cloudPayload(commerce.orderLines[0])),
      response('/v2/sales-orders/{salesOrderId}/line-items', true),
    );
    validate(
      s.item.parse(cloudPayload(commerce.items[0])),
      response('/v2/items', true),
    );
    validate(
      s.warehouseStock.parse(commerce.warehouseStock),
      response('/v2/warehouses/{warehouseId}/items/{itemId}/stocks'),
    );
    validate(
      s.note.parse(cloudPayload(commerce.details[0])),
      response('/v2/delivery-notes/{deliveryNoteId}'),
    );
    validate(
      s.noteLine.parse(cloudPayload(commerce.noteLines[0]![0])),
      response('/v2/delivery-notes/{deliveryNoteId}/line-items', true),
    );
    expect(() =>
      validate({ sku: 'incorrect-casing' }, response('/v2/items', true)),
    ).toThrow('Unknown provider field');
  });
  it('accepts the optional item unit from the published contract', () => {
    const schema = resolve(response('/v2/items', true));
    expect(schema.properties?.unit).toEqual({ type: 'string' });
    expect(schema.required).not.toContain('unit');
    const item = structuredClone(commerce.items[0]!);
    Reflect.deleteProperty(item, 'unit');
    const parsed = s.item.parse(cloudPayload(item));
    expect(parsed.unit).toBeUndefined();
    validate(parsed, schema);
  });

  it('retains the documented fulfillment filter and paged child endpoint', () => {
    expect(api.paths['/v2/delivery-notes'].parameters).toContainEqual({
      name: 'salesOrderNumberId',
      in: 'query',
    });
    expect(
      api.paths['/v2/delivery-notes/{deliveryNoteId}/line-items'].parameters,
    ).toEqual(
      expect.arrayContaining([
        { name: 'pageNumber', in: 'query' },
        { name: 'pageSize', in: 'query' },
      ]),
    );
  });
});
