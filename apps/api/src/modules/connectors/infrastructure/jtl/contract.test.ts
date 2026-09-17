import { describe, expect, it } from 'vitest';
import { cloudPayload } from './fixtures/cloud.js';
import { API_VERSION } from './client.js';
import * as s from './schemas.js';
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
  }
}
function response(path: keyof typeof api.paths, list = false): Schema {
  const schema = resolve(api.paths[path].response);
  return list ? resolve(schema.properties?.items ?? schema).items! : schema;
}

describe('JTL 2.2 published contract', () => {
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
