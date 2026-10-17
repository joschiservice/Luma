import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TenantContext } from '@luma/identity';
import { buildSchema, parse, validate } from 'graphql';
import { expect, it, vi } from 'vitest';

import {
  correctionBlocker,
  inventoryReconciled,
} from '../domain/inventory-correction.js';
import {
  type CorrectionEvidence,
  createInventoryCorrectionProvider,
} from './inventory-correction-provider.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);
const inventoryItemId = 'gid://shopify/InventoryItem/1',
  locationId = 'gid://shopify/Location/1';

function fixture() {
  const node = {
    id: inventoryItemId,
    tracked: true,
    variant: {
      requiresComponents: false,
      productVariantComponents: { nodes: [] as { id: string }[] },
    },
    inventoryLevel: {
      id: 'gid://shopify/InventoryLevel/1',
      isActive: true,
      updatedAt: new Date().toISOString(),
      location: { id: locationId, name: 'Tokyo', isActive: true },
      quantities: [{ name: 'available', quantity: 12 }],
    },
  };
  let loseResponse = false,
    refuse = false;
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(validate(schema, parse(body.query))).toEqual([]);
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      if (loseResponse) throw new Error('Transport lost');

      return Response.json({
        data: {
          result: {
            inventoryAdjustmentGroup: refuse
              ? null
              : {
                  id: 'gid://shopify/InventoryAdjustmentGroup/1',
                  reason: 'correction',
                  referenceDocumentUri:
                    body.variables.input.referenceDocumentUri,
                  changes: [
                    { name: 'available', delta: -3, quantityAfterChange: 9 },
                  ],
                },
            userErrors: refuse
              ? [
                  {
                    code: 'CHANGE_FROM_QUANTITY_STALE',
                    field: ['quantities'],
                    message: 'stale',
                  },
                ]
              : [],
          },
        },
      });
    }

    return Response.json({ data: { node } });
  });
  const record = vi.fn<(evidence: CorrectionEvidence) => Promise<void>>(
      async () => {},
    ),
    eligible = vi.fn(async () => true);
  const tenantId = randomUUID(),
    connectionId = randomUUID();
  const provider = createInventoryCorrectionProvider({
    tenantId,
    connectionId,
    shop: 'stock.myshopify.com',
    accessToken: async () => 'test',
    fetch: transport,
    record,
    eligible,
  });
  const handler = provider.capabilities['inventory.available.reconcile'];
  const context = {
    tenant: { tenantId } as TenantContext,
    connectionId,
    provider: 'shopify',
    idempotencyKey: randomUUID(),
  };
  const input = async () => ({
    inventoryItemId,
    locationId,
    expectedRevision: (await provider.read(inventoryItemId, locationId))
      .targetRevision,
    expectedAvailable: 12,
    available: 9,
  });

  return {
    provider,
    handler,
    context,
    input,
    node,
    mutations,
    record,
    eligible,
    lose: () => {
      loseResponse = true;
    },
    refuse: () => {
      refuse = true;
    },
  };
}

it('validates pinned GraphQL queries and sends exact CAS with provider idempotency', async () => {
  const f = fixture();
  await expect(
    f.handler.run(f.context, await f.input()),
  ).resolves.toMatchObject({ status: 'accepted' });
  expect(f.mutations).toHaveLength(1);
  expect(f.mutations[0]!.variables).toMatchObject({
    key: f.context.idempotencyKey,
    input: {
      name: 'available',
      referenceDocumentUri: `luma://inventory-corrections/${f.context.idempotencyKey}`,
      quantities: [
        { inventoryItemId, locationId, changeFromQuantity: 12, quantity: 9 },
      ],
    },
  });
  expect(f.record.mock.calls).toHaveLength(3);
  expect(f.record.mock.calls[2]?.[0]).toMatchObject({
    kind: 'acceptance',
    document: {
      adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/1',
      referenceDocumentUri: `luma://inventory-corrections/${f.context.idempotencyKey}`,
    },
  });
});
it('stores reads and the acceptance with their adapter version, completeness and dispatch identity', async () => {
  const f = fixture();
  const context = {
    ...f.context,
    adapterVersion: 'shopify-inventory/1',
    dispatchIdentity: '["shopify","shopify-inventory/1"]',
  };
  await f.handler.run(context, await f.input());
  const [read, , acceptance] = f.record.mock.calls.map(([call]) => call);
  expect(read).toMatchObject({
    kind: 'observation',
    document: {
      adapterVersion: 'shopify-inventory/1',
      completeness: 'complete',
      sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceUpdatedAt: f.node.inventoryLevel.updatedAt,
      record: {
        resource: 'inventory_level',
        externalId: 'gid://shopify/InventoryLevel/1',
      },
    },
  });
  expect(acceptance).toMatchObject({
    kind: 'acceptance',
    document: {
      adapterVersion: 'shopify-inventory/1',
      dispatchIdentity: context.dispatchIdentity,
      idempotencyKey: context.idempotencyKey,
      records: [
        {
          resource: 'inventory_adjustment_group',
          externalId: 'gid://shopify/InventoryAdjustmentGroup/1',
        },
      ],
    },
  });
});
it('marks a read partial when the collection page was cut short', async () => {
  const record = vi.fn<(evidence: CorrectionEvidence) => Promise<void>>(
    async () => {},
  );
  const provider = createInventoryCorrectionProvider({
    tenantId: randomUUID(),
    connectionId: randomUUID(),
    shop: 'stock.myshopify.com',
    accessToken: async () => 'test',
    includeCollections: true,
    record,
    fetch: async () =>
      Response.json({
        data: {
          node: {
            id: inventoryItemId,
            tracked: true,
            variant: {
              requiresComponents: false,
              productVariantComponents: { nodes: [] },
              product: {
                status: 'ACTIVE',
                tags: [],
                collections: {
                  nodes: [{ id: 'gid://shopify/Collection/1' }],
                  pageInfo: { hasNextPage: true },
                },
              },
            },
            inventoryLevel: null,
          },
        },
      }),
  });
  await provider.read(inventoryItemId, locationId);
  expect(record.mock.calls[0]?.[0].document).toMatchObject({
    completeness: 'partial',
    sourceUpdatedAt: null,
    record: { resource: 'inventory_item', externalId: inventoryItemId },
  });
});
it('counts an accepted correction whose receipt cannot be stored as sent with an unknown outcome', async () => {
  const f = fixture();
  const input = await f.input();
  f.record.mockImplementation(async (evidence) => {
    if (evidence.kind === 'acceptance') throw new Error('Database unavailable');
  });
  await expect(f.handler.run(f.context, input)).rejects.toMatchObject({
    failure: { effect: 'unknown', retry: 'reconcile', dispatch: 'dispatched' },
  });
  expect(f.mutations).toHaveLength(1);
});
it('withholds incomplete, untracked, concurrent or revoked-authority stock before dispatch', async () => {
  for (const change of [
    'quantity',
    'tracked',
    'location',
    'item',
    'source',
  ] as const) {
    const f = fixture(),
      input = await f.input();
    if (change === 'quantity')
      f.node.inventoryLevel.quantities[0]!.quantity = 10;
    if (change === 'tracked') f.node.tracked = false;
    if (change === 'location') f.node.inventoryLevel.location.isActive = false;
    if (change === 'item') f.node.inventoryLevel.isActive = false;
    if (change === 'source') f.eligible.mockResolvedValue(false);
    await expect(f.handler.run(f.context, input)).rejects.toMatchObject({
      failure: { effect: 'none', dispatch: 'not_dispatched' },
    });
    expect(f.mutations).toHaveLength(0);
  }
});
it('distinguishes Shopify CAS refusal from an uncertain write response', async () => {
  const f = fixture();
  f.refuse();
  await expect(f.handler.run(f.context, await f.input())).rejects.toMatchObject(
    { failure: { dispatch: 'not_dispatched' } },
  );
  const lost = fixture();
  lost.lose();
  await expect(
    lost.handler.run(lost.context, await lost.input()),
  ).rejects.toMatchObject({
    failure: { effect: 'unknown', retry: 'reconcile', dispatch: 'uncertain' },
  });
});
it('requires fresh source evidence and a separate complete exact-location read for verification', async () => {
  const f = fixture();
  const before = {
    ...(await f.provider.read(inventoryItemId, locationId)),
    revision: 'before',
    source: {
      connectionId: randomUUID(),
      label: 'ERP',
      observationId: randomUUID(),
      observedAt: new Date().toISOString(),
      revision: 'erp-1',
      available: 9,
    },
  };
  expect(
    correctionBlocker(before, { capability: 'inventory.available.reconcile' }, [
      'inventory.available.reconcile',
    ]),
  ).toBeNull();
  expect(
    correctionBlocker(
      {
        ...before,
        source: {
          ...before.source,
          observedAt: new Date(Date.now() - 300_000).toISOString(),
        },
      },
      { capability: 'inventory.available.reconcile' },
      ['inventory.available.reconcile'],
    ),
  ).toContain('stale');
  const after = { ...before, id: randomUUID(), available: 9 };
  expect(inventoryReconciled(before, after)).toBe(true);
  expect(inventoryReconciled(before, { ...after, id: before.id })).toBe(false);
  expect(inventoryReconciled(before, { ...after, complete: false })).toBe(
    false,
  );
  expect(
    inventoryReconciled(before, {
      ...after,
      locationId: 'gid://shopify/Location/2',
    }),
  ).toBe(false);
  expect(
    inventoryReconciled(before, {
      ...after,
      source: { ...after.source, revision: 'erp-2' },
    }),
  ).toBe(false);
});

it.each(['required', 'optional'])(
  'withholds a %s bundle parent, including a recipe changed after preview',
  async (kind) => {
    const f = fixture(),
      input = await f.input();
    if (kind === 'required') f.node.variant.requiresComponents = true;
    else
      f.node.variant.productVariantComponents.nodes.push({
        id: 'gid://shopify/ProductVariantComponent/1',
      });
    const fresh = await f.provider.read(inventoryItemId, locationId);
    expect(fresh).toMatchObject({ bundleParent: true, complete: false });
    await expect(f.handler.run(f.context, input)).rejects.toMatchObject({
      failure: { effect: 'none', dispatch: 'not_dispatched' },
    });
    expect(f.mutations).toHaveLength(0);
  },
);

it('does not dispatch when requested bundle metadata is missing', async () => {
  const f = fixture(),
    input = await f.input();
  Reflect.deleteProperty(f.node, 'variant');
  await expect(f.handler.run(f.context, input)).rejects.toMatchObject({
    failure: { code: 'invalid_response', effect: 'none' },
  });
  expect(f.mutations).toHaveLength(0);
});

it('binds a manual receipt increment to the exact baseline and verifies only a separate stock read', async () => {
  const f = fixture();
  const receipt = {
    purchaseOrderId: randomUUID(),
    lineId: randomUUID(),
    commitmentId: randomUUID(),
    damagedCommitmentId: randomUUID(),
    baselineAvailable: 12,
    quantity: 40,
    cumulativeGood: 40,
  };
  const before = {
    ...(await f.provider.read(inventoryItemId, locationId)),
    revision: 'receipt-before',
    source: {
      connectionId: randomUUID(),
      label: 'Manual receipt',
      observationId: receipt.commitmentId,
      observedAt: new Date().toISOString(),
      revision: 'receipt-1',
      available: 52,
      receipt,
    },
  };
  expect(
    correctionBlocker(before, { capability: 'inventory.available.reconcile' }, [
      'inventory.available.reconcile',
    ]),
  ).toBeNull();
  expect(
    correctionBlocker(
      { ...before, available: 13 },
      { capability: 'inventory.available.reconcile' },
      ['inventory.available.reconcile'],
    ),
  ).toContain('stale');
  expect(
    inventoryReconciled(before, { ...before, id: randomUUID(), available: 52 }),
  ).toBe(true);
  expect(inventoryReconciled(before, { ...before, available: 52 })).toBe(false);
  expect(
    inventoryReconciled(before, { ...before, id: randomUUID(), available: 50 }),
  ).toBe(false);
  expect(
    inventoryReconciled(before, {
      ...before,
      id: randomUUID(),
      available: 52,
      source: { ...before.source, revision: 'changed-receipt' },
    }),
  ).toBe(false);
});
