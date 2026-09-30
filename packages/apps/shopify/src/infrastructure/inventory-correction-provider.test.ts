import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TenantContext } from '@luma/identity';
import { buildSchema, parse, validate } from 'graphql';
import { expect, it, vi } from 'vitest';

import {
  correctionBlocker,
  inventoryReconciled,
} from '../domain/inventory-correction.js';
import { createInventoryCorrectionProvider } from './inventory-correction-provider.js';

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
    inventoryLevel: {
      id: 'gid://shopify/InventoryLevel/1',
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
                  reason: 'correction',
                  referenceDocumentUri: null,
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
  const record = vi.fn(async () => {}),
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
      quantities: [
        { inventoryItemId, locationId, changeFromQuantity: 12, quantity: 9 },
      ],
    },
  });
  expect(f.record.mock.calls).toHaveLength(3);
});
it('withholds incomplete, untracked, concurrent or revoked-authority stock before dispatch', async () => {
  for (const change of ['quantity', 'tracked', 'location', 'source'] as const) {
    const f = fixture(),
      input = await f.input();
    if (change === 'quantity')
      f.node.inventoryLevel.quantities[0]!.quantity = 10;
    if (change === 'tracked') f.node.tracked = false;
    if (change === 'location') f.node.inventoryLevel.location.isActive = false;
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
