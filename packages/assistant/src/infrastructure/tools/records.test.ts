import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import type { InventoryWorkspace } from '@luma/read-models';
import { describe, expect, it, vi } from 'vitest';

import { createToolRegistry } from '../../application/tools.js';
import { insightTools } from './insights.js';
import { getCustomerTool, getStockTool } from './records.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const id = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-10-13T00:00:00Z';
const context = makeTenantContext(
  { userId: 'u', sessionId: 's' },
  {
    id: tenantId,
    name: 'Workspace',
    slug: 'workspace',
    status: 'active',
    dataRegion: 'AU',
  },
  builtInMembership(
    { id: 'membership', organizationId: tenantId, userId: 'u' },
    'owner',
  ),
  'request',
);

const stock: NonNullable<Awaited<ReturnType<InventoryWorkspace['get']>>> = {
  position: {
    id,
    skuId: id,
    sku: 'SKU-1',
    skuKey: 'SKU-1',
    locationId: id,
    location: 'Warehouse',
    unit: 'each',
    differences: ['available'],
    sync: null,
    sources: [
      {
        connectionId: id,
        label: 'Store',
        status: 'disconnected',
        externalSku: 'SKU-1',
        externalLocation: null,
        mappingMethod: 'confirmed',
        onHand: '8',
        reserved: '2',
        available: null,
        incoming: null,
        availabilityBasis: 'unknown',
        observedAt,
        sourceUpdatedAt: null,
        deleted: false,
      },
    ],
  },
  history: { entries: [], truncated: false },
  orders: [],
  purchaseOrders: [],
  issues: [],
  relatedTruncated: false,
  hidden: ['orders', 'purchaseOrders'],
  asOf: observedAt,
};

describe('contextual record evidence', () => {
  it('keeps unknown quantities, disconnects and hidden cross-area sections explicit', async () => {
    const get = vi.fn(async () => stock);
    const tools = createToolRegistry([getStockTool({ get })]);
    const result = await tools.execute(context, {
      name: 'get_stock',
      arguments: { id },
    });
    expect(get).toHaveBeenCalledWith(context, id);
    expect(JSON.parse(result.content)).toMatchObject({
      position: {
        sources: [{ available: null, status: 'disconnected', observedAt }],
      },
      hidden: ['orders', 'purchaseOrders'],
    });
    expect(result.records).toMatchObject([
      { kind: 'stock_position', id, observedAt, sources: [{ label: 'Store' }] },
    ]);
  });

  it('reads customer provenance without disclosing withheld contact details to the model', async () => {
    const get = vi.fn(async () => ({
      item: {
        id,
        connectionId: id,
        externalId: 'customer-1',
        displayName: null,
        email: 'private@example.test',
        phone: 'private',
        state: 'enabled' as const,
        sourceCreatedAt: null,
        orderCount: null,
        amountSpent: null,
        tags: [],
        shared: { contact: false, address: false },
        sourceUpdatedAt: null,
        observedAt,
        missingSince: null,
        country: null,
      },
      address: null,
      source: null,
      asOf: observedAt,
    }));
    const tools = createToolRegistry([getCustomerTool({ get })]);
    const result = await tools.execute(context, {
      name: 'get_customer',
      arguments: { id },
    });
    expect(result.content).not.toContain('private');
    expect(JSON.parse(result.content).customer.shared).toEqual({
      contact: false,
      address: false,
    });
    expect(result.records[0]).toMatchObject({
      kind: 'customer',
      id,
      observedAt,
      sources: [],
    });
  });

  it('does not read a different tenant when its owner service reports the contextual ID missing', async () => {
    const get = vi.fn(async () => null);
    const tools = createToolRegistry([getCustomerTool({ get })]);
    const result = await tools.execute(context, {
      name: 'get_customer',
      arguments: { id },
    });
    expect(get).toHaveBeenCalledWith(context, id);
    expect(result.step.outcome).toBe('not_found');
    expect(result.records).toEqual([]);
  });

  it('retains the exact chart scope and never calls evaluation time an observation time', async () => {
    const records = vi.fn(async () => ({
      chart: 'orders' as const,
      point: '2026-10-13',
      series: 'open',
      totalCount: 1,
      items: [
        {
          kind: 'order' as const,
          id,
          number: '#1',
          placedAt: observedAt,
          status: 'open',
          fulfillment: 'partial',
          total: null,
          sources: [{ connectionId: id, label: 'Store' }],
          attentionIssueIds: [],
        },
      ],
      nextOffset: null,
      asOf: observedAt,
    }));
    const chart = vi.fn(async () => ({
      chart: 'orders' as const,
      kind: 'timeline' as const,
      unit: 'order' as const,
      series: ['open'],
      points: [],
      total: 1,
      window: null,
      sourceFilter: 'applied' as const,
      coverage: { state: 'partial' as const, sources: [], excluded: [] },
      dataThrough: null,
      asOf: observedAt,
    }));
    const tools = createToolRegistry(insightTools({ records, chart }));
    const query = {
      range: '7d',
      timeZone: 'Europe/Berlin',
      connectionId: id,
      point: '2026-10-13',
      series: 'open',
      asOf: observedAt,
      offset: 0,
      limit: 25,
    };
    const result = await tools.execute(context, {
      name: 'read_insight_orders',
      arguments: query,
    });
    expect(records).toHaveBeenCalledWith(context, 'orders', query);
    expect(result.records[0]?.observedAt).toBeNull();
    expect(JSON.parse(result.content)).toMatchObject({
      coverage: { state: 'partial' },
      evaluationTime: observedAt,
    });
  });

  it('requires both chart and area permissions before offering or reading drilldown tools', async () => {
    const records = vi.fn();
    const chart = vi.fn();
    const tools = createToolRegistry(insightTools({ records, chart }));
    const restricted = {
      ...context,
      permissions: new PermissionSet(['assistant.use', 'orders.read']),
    };
    expect(tools.declarations(restricted)).toEqual([]);
    expect(
      (
        await tools.execute(restricted, {
          name: 'read_insight_orders',
          arguments: {},
        })
      ).step.outcome,
    ).toBe('failed');
    expect(records).not.toHaveBeenCalled();
  });
});
