import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { InventorySnapshot, Observation } from '@luma/connections';
import { createClient } from '@luma/connector-shopify';
import { buildSchema, parse, validate } from 'graphql';
import { expect, it, vi } from 'vitest';

import {
  attributeInventoryWrites,
  type InventoryWriteReceipt,
  readInventoryWriteProofs,
} from './inventory-write-attribution.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);
const receipt: InventoryWriteReceipt = {
  evidenceId: randomUUID(),
  observedAt: '2026-10-12T00:00:00Z',
  inventoryItemId: 'gid://shopify/InventoryItem/1',
  locationId: 'gid://shopify/Location/1',
  adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/1',
  referenceDocumentUri: 'luma://inventory-corrections/v0:action-1',
  idempotencyKey: 'v0:action-1',
  expectedAvailable: 12,
  available: 9,
};

function observation(
  available: string | null = '9',
): Pick<Observation<InventorySnapshot>, 'kind' | 'observedAt' | 'data'> {
  return {
    kind: 'snapshot',
    observedAt: '2026-10-12T00:01:00Z',
    data: {
      sku: { externalId: receipt.inventoryItemId, scopeKey: '' },
      location: { externalId: receipt.locationId, scopeKey: '' },
      unit: 'each',
      onHand: null,
      reserved: null,
      available,
      availabilityBasis: 'provider_reported',
    },
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const group = {
    id: receipt.adjustmentId,
    reason: 'correction',
    referenceDocumentUri: receipt.referenceDocumentUri,
    changes: [{ name: 'available', delta: -3, quantityAfterChange: 9 }],
    ...overrides,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(validate(schema, parse(body.query))).toEqual([]);
    expect(body.variables.item0).toEqual([receipt.inventoryItemId]);
    expect(body.variables.location0).toEqual([receipt.locationId]);
    const data = Object.fromEntries(
      Object.keys(body.variables)
        .filter((key) => key.startsWith('id'))
        .map((key) => [`proof${key.slice(2)}`, group]),
    );

    return Response.json({ data });
  });
  const request = createClient({
    shop: 'stock.myshopify.com',
    accessToken: async () => 'synthetic',
    fetch,
    readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => {} },
  });

  return { request, fetch };
}

it('corroborates the exact adjustment while retaining simultaneous residual changes and unknown quantities', async () => {
  const f = fixture();
  const matching = observation(),
    changed = observation('8'),
    unknown = observation(null);
  await attributeInventoryWrites(
    f.request,
    [matching, changed, unknown],
    [receipt],
  );
  expect(matching.data.writeAttribution).toMatchObject({
    referenceDocumentUri: receipt.referenceDocumentUri,
    quantityMatches: true,
  });
  expect(changed.data.available).toBe('8');
  expect(changed.data.writeAttribution?.quantityMatches).toBe(false);
  expect(unknown.data.writeAttribution?.quantityMatches).toBeNull();
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('withholds attribution for missing, forged, changed or ambiguous adjustment facts', async () => {
  for (const group of [
    { id: 'gid://shopify/InventoryAdjustmentGroup/2' },
    { referenceDocumentUri: 'luma://inventory-corrections/another-action' },
    { reason: 'other' },
    { changes: [] },
    { changes: [{ name: 'available', delta: -2, quantityAfterChange: 9 }] },
    { changes: [{ name: 'available', delta: -3, quantityAfterChange: 8 }] },
    { changes: [{ name: 'reserved', delta: -3, quantityAfterChange: 9 }] },
    {
      changes: [
        { name: 'available', delta: -3, quantityAfterChange: 9 },
        { name: 'available', delta: 1, quantityAfterChange: 10 },
      ],
    },
  ]) {
    const f = fixture(group),
      current = observation();
    await attributeInventoryWrites(f.request, [current], [receipt]);
    expect(current.data.writeAttribution).toBeUndefined();
  }
});

it('does not correlate another location, an earlier observation, a tombstone or an unbound reference', async () => {
  const f = fixture();
  const other = observation();
  other.data.location.externalId = 'gid://shopify/Location/2';
  const earlier = observation();
  earlier.observedAt = '2026-10-11T00:00:00Z';
  const removed = observation();
  removed.kind = 'tombstone';
  await attributeInventoryWrites(
    f.request,
    [other, earlier, removed],
    [receipt],
  );
  await attributeInventoryWrites(
    f.request,
    [observation()],
    [{ ...receipt, referenceDocumentUri: 'other://action' }],
  );
  expect(f.fetch).not.toHaveBeenCalled();
});

it('bounds proof work to one request with twenty adjustments and treats unavailable proof as unknown', async () => {
  const f = fixture();
  const receipts = Array.from({ length: 100 }, () => receipt);
  expect(await readInventoryWriteProofs(f.request, receipts)).toHaveLength(20);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.fetch.mockResolvedValue(Response.json({ data: { proof0: null } }));
  expect(await readInventoryWriteProofs(f.request, [receipt])).toEqual([]);
  f.fetch.mockResolvedValue(
    Response.json({ errors: [{ message: 'unavailable' }] }),
  );
  expect(await readInventoryWriteProofs(f.request, [receipt])).toEqual([]);
});
