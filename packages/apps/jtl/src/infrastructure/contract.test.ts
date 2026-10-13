import { API_VERSION } from '@luma/connector-jtl';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import { createJtlConnector } from './adapter.js';
import { cloudPayload } from './fixtures/cloud.js';
import commerce from './fixtures/commerce.json' with { type: 'json' };
import api from './fixtures/erp-2.2.json' with { type: 'json' };
import { acceptanceId } from './purchase-orders.js';
import { lumaReturnMarker, returnAcceptanceId } from './returns.js';
import * as s from './schemas.js';
import {
  shippingMethodResponse,
  shippingMethodState,
} from './shipping-method.js';

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
          shippingDetails: { shippingDate: null },
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
        shippingDetails: { shippingDate: null },
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
    // A point read consumes the same facts from the single-order response's detail objects.
    const order = cloudPayload(commerce.orders[0]) as Record<string, unknown>;
    validate(
      s.orderDetailFields.parse({
        ...order,
        externalDetails: {
          externalSalesOrderNumber: order.externalSalesOrderNumber,
        },
        paymentDetails: { currencyIso: order.currencyIso },
        keyFigures: {
          deliveryStatus: order.deliveryStatus,
          paymentStatus: order.paymentStatus,
          totalGrossAmount: order.totalGrossAmount,
        },
      }),
      response('/v2/sales-orders/{salesOrderId}'),
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
  it('validates the customer projection and its change filter against the published contract', () => {
    for (const row of commerce.customers)
      validate(
        s.customer.parse(cloudPayload(row)),
        response('/v2/customers', true),
      );
    expect(api.paths['/v2/customers'].parameters).toContainEqual({
      name: 'lastChangedAfter',
      in: 'query',
    });
    expect(api.paths['/v2/customers'].scopes).toEqual(['customers.read']);
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

  it('pins the consumed supplier and purchase-order projections and scopes', () => {
    const id = cloudIdForContract;
    validate(
      s.supplier.parse({
        id,
        name: 'Legacy',
        companyName: 'Nordwind Textil GmbH',
        supplierNumber: 'L-1',
      }),
      response('/v2/suppliers', true),
    );
    validate(
      s.supplierDetail.parse({
        id,
        companyName: 'Nordwind Textil GmbH',
        isActive: true,
        contact: { emailAddress: 'orders@example.test' },
      }),
      response('/v2/suppliers/{supplierId}'),
    );
    validate(
      s.itemSupplier.parse({
        id,
        itemId: id,
        supplierId: id,
        netPurchasePrice: '3.75',
        vatRate: 19,
      }),
      response('/v2/items/{itemId}/suppliers', true),
    );
    validate(
      s.purchaseOrderListItem.parse({ purchaseOrderId: id }),
      response('/v2/purchase-orders', true),
    );
    const { lumaOrderIds, ...order } = s.purchaseOrder.parse({
      purchaseOrderId: id,
      supplierId: id,
      orderNumber: 'PO-1',
      status: 30,
      isConfirmed: true,
      requestedDeliveryDate: '2026-10-07T00:00:00Z',
      createdAt: '2026-10-01T08:00:00Z',
      internalComment: 'luma-po:abc',
      lineItems: [
        {
          lineItemId: id,
          lineItemType: 1,
          itemId: id,
          itemNumber: 'SKU',
          quantity: 10,
          deliveredQuantity: 4,
          openQuantity: 6,
          confirmedQuantity: 10,
          confirmedDeliveryDate: '2026-10-08T00:00:00Z',
          isLineItemConfirmed: true,
          deliveryDate: '2026-10-07T00:00:00Z',
        },
      ],
    });
    expect(lumaOrderIds).toEqual(['abc']);
    const detail = response('/v2/purchase-orders/{purchaseOrderId}');
    validate(order, detail);
    expect(resolve(detail.properties!.internalComment!).type).toBe('string');
    expect(
      resolve(resolve(detail.properties!.lineItems!).items!).properties,
    ).toHaveProperty('lineItemType');
    expect(api.paths['/v2/purchase-orders'].parameters).toEqual(
      expect.arrayContaining([
        { name: 'createdAtAfter', in: 'query' },
        { name: 'pageNumber', in: 'query' },
        { name: 'pageSize', in: 'query' },
      ]),
    );
    // Installation probes map these provider scopes to Luma capabilities.
    expect(api.paths['/v2/suppliers'].scopes).toEqual(['suppliers.read']);
    expect(api.paths['/v2/purchase-orders'].scopes).toEqual([
      'purchaseorders.read',
    ]);
    expect(api.paths['/v2/items/{itemId}/suppliers'].scopes).toEqual([
      'items.read',
    ]);
    expect(api.purchaseOrderCreate.scopes).toEqual(['purchaseorders.write']);
  });

  it('sends a schema-valid purchase-order create with the provider idempotency header', async () => {
    const id = cloudIdForContract;
    let body: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') {
        body = JSON.parse(String(init.body));

        return Response.json({ purchaseOrderId: id }, { status: 201 });
      }
      if (path.endsWith('/suppliers'))
        return Response.json({
          items: [
            {
              id,
              itemId: id,
              supplierId: id,
              netPurchasePrice: 3.75,
              vatRate: 19,
            },
          ],
          totalItems: 1,
          pageNumber: 1,
          pageSize: 100,
        });

      return Response.json({
        items: [],
        totalItems: 0,
        pageNumber: 1,
        pageSize: 100,
      });
    });
    const connector = createJtlConnector({
      tenantId: 'tenant-a',
      connectionId: 'connection-a',
      purchaseOrderActions: true,
      recordObservations: async () => {},
      fetch,
      connection: {
        kind: 'cloud',
        jtlTenantId: id,
        accessToken: async () => 'token',
      },
    });
    const receipt = await connector.capabilities['purchase-orders.submit']!.run(
      {
        tenant: { tenantId: 'tenant-a' } as TenantContext,
        connectionId: 'connection-a',
        provider: 'jtl',
        idempotencyKey: 'key',
      },
      {
        lumaOrderId: 'po-1',
        reference: 'PO-1',
        supplier: { externalId: id, scopeKey: '' },
        requestedDeliveryDate: '2026-10-12',
        lines: [
          {
            sku: { externalId: id, scopeKey: '' },
            quantity: { amount: '5', unit: 'each' },
          },
        ],
      },
    );
    validate(body, api.purchaseOrderCreate.request);
    validate(
      s.purchaseOrderCreated.parse({ purchaseOrderId: id }),
      api.purchaseOrderCreate.response,
    );
    expect(receipt.evidenceRefs).toEqual([
      acceptanceId('tenant-a', 'connection-a', id),
    ]);
    expect(api.purchaseOrderCreate.parameters).toContainEqual({
      name: 'Idempotency-Key',
      in: 'header',
    });
    expect(resolve(api.purchaseOrderCreate.request).required).toEqual(
      expect.arrayContaining(['supplierId', 'requestedDeliveryDate', 'items']),
    );
  });

  it('pins the consumed return projections, filters and scopes', () => {
    const id = cloudIdForContract;
    validate(
      s.salesOrderCompany.parse({ id, companyId: id, isCancelled: false }),
      response('/v2/sales-orders/{salesOrderId}'),
    );
    validate(
      s.warehouse.parse({ id, name: 'Hamburg', active: true }),
      response('/v2/warehouses', true),
    );
    validate(
      s.returnReason.parse({
        id,
        translations: [{ languageIso: 'EN', name: 'Defective' }],
      }),
      resolve(response('/v2/return-reasons')).items!,
    );
    validate(
      s.returnRow.parse({
        id,
        number: 'RE-1',
        returnDate: '2026-10-01T08:00:00Z',
        externalNumber: 'luma-rc:case',
        salesOrderId: id,
        warehouseId: id,
      }),
      response('/v2/returns', true),
    );
    validate(
      s.returnLine.parse({
        id,
        returnId: id,
        quantity: 1.5,
        returnReasonId: id,
        salesOrderLineItemId: id,
      }),
      resolve(response('/v2/returns/{returnId}/line-items')).items!,
    );
    validate(s.returnCreated.parse({ id }), api.returnCreate.response);
    expect(api.paths['/v2/returns'].parameters).toEqual(
      expect.arrayContaining([
        { name: 'salesOrderId', in: 'query' },
        { name: 'pageNumber', in: 'query' },
        { name: 'pageSize', in: 'query' },
      ]),
    );
    // Installation probes map these provider scopes to Luma capabilities.
    expect(api.paths['/v2/returns'].scopes).toEqual(['returns.read']);
    expect(api.paths['/v2/return-reasons'].scopes).toEqual(['returns.read']);
    expect(api.paths['/v2/warehouses'].scopes).toEqual(['inventory.read']);
    expect(api.returnCreate.scopes).toEqual(['returns.write']);
    // JTL documents no idempotency header here, so duplicates are ruled out by the marker read.
    expect(
      api.returnCreate.parameters.some(
        (p) => p.name.toLowerCase() === 'idempotency-key',
      ),
    ).toBe(false);
  });

  it('sends a schema-valid return create', async () => {
    const id = cloudIdForContract;
    let body: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') {
        body = JSON.parse(String(init.body));

        return Response.json({ id }, { status: 201 });
      }
      if (path.endsWith('/line-items'))
        return Response.json([
          { id, salesOrderId: id, itemId: id, quantity: 3, salesUnit: 'Stück' },
        ]);
      if (path.endsWith(`/sales-orders/${id}`))
        return Response.json({ id, companyId: id, isCancelled: false });

      return Response.json({
        items: [],
        totalItems: 0,
        pageNumber: 1,
        pageSize: 100,
      });
    });
    const connector = createJtlConnector({
      tenantId: 'tenant-a',
      connectionId: 'connection-a',
      returnActions: true,
      recordObservations: async () => {},
      fetch,
      connection: {
        kind: 'cloud',
        jtlTenantId: id,
        accessToken: async () => 'token',
      },
    });
    const receipt = await connector.capabilities['returns.create']!.run(
      {
        tenant: { tenantId: 'tenant-a' } as TenantContext,
        connectionId: 'connection-a',
        provider: 'jtl',
        idempotencyKey: 'key',
      },
      {
        lumaCaseId: 'case-1',
        order: { externalId: id, scopeKey: '' },
        warehouse: { externalId: id, scopeKey: '' },
        reason: { externalId: id, scopeKey: '' },
        lines: [
          {
            orderLine: { externalId: id, scopeKey: id },
            quantity: { amount: '2', unit: 'each' },
          },
        ],
      },
    );
    validate(body, api.returnCreate.request);
    expect(body).toMatchObject({ externalNumber: lumaReturnMarker('case-1') });
    expect(receipt.evidenceRefs).toEqual([
      returnAcceptanceId('tenant-a', 'connection-a', id),
    ]);
    expect(resolve(api.returnCreate.request).required).toEqual(
      expect.arrayContaining([
        'companyId',
        'salesOrderId',
        'warehouseId',
        'items',
      ]),
    );
  });
});
