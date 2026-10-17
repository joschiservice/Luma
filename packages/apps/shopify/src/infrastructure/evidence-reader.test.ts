import type { SqlTransaction } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import { readShopifyEvidence } from './evidence-reader.js';

const observedAt = new Date('2026-10-17T10:00:00.000Z');

function transaction(
  rows: { id: string; kind: string; document: unknown; inventory?: boolean }[],
): SqlTransaction {
  return {
    query: async () => ({
      rows: rows.map((row) => ({
        inventory: false,
        ...row,
        connection_id: 'connection',
        observed_at: observedAt,
      })),
    }),
  } as unknown as SqlTransaction;
}

describe('Shopify evidence reader', () => {
  it('returns the provenance new reads and acceptances recorded', async () => {
    const evidence = await readShopifyEvidence(
      transaction([
        {
          id: 'read',
          kind: 'observation',
          document: {
            complete: true,
            available: 4,
            adapterVersion: 'shopify-inventory/1',
            completeness: 'partial',
            sourceRevision: 'a'.repeat(64),
            sourceUpdatedAt: '2026-10-17T09:00:00.000Z',
            record: { resource: 'inventory_level', externalId: 'gid://1' },
          },
        },
        {
          id: 'receipt',
          kind: 'acceptance',
          document: {
            capability: 'fulfillment.open',
            adapterVersion: 'shopify-fulfillment/1',
            dispatchIdentity: '["shopify"]',
            idempotencyKey: 'v0:1',
            records: [{ resource: 'fulfillment_order', externalId: 'gid://2' }],
          },
        },
      ]),
      'tenant',
      ['read', 'receipt'],
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: 'read',
        record: { resource: 'inventory_level', externalId: 'gid://1' },
        sourceUpdatedAt: '2026-10-17T09:00:00.000Z',
        sourceRevision: 'a'.repeat(64),
        adapterVersion: 'shopify-inventory/1',
        // The recorded completeness wins over the eligibility flag.
        completeness: 'partial',
      }),
      {
        kind: 'write_receipt',
        id: 'receipt',
        provider: 'shopify',
        connectionId: 'connection',
        capability: 'fulfillment.open',
        acceptedAt: observedAt.toISOString(),
        records: [{ resource: 'fulfillment_order', externalId: 'gid://2' }],
        providerRequestId: null,
        adapterVersion: 'shopify-fulfillment/1',
        dispatchIdentity: '["shopify"]',
      },
    ]);
  });

  it('leaves fields older rows never recorded as null', async () => {
    const evidence = await readShopifyEvidence(
      transaction([
        { id: 'read', kind: 'observation', document: { complete: false } },
        // An inventory read's `complete` flag meant the item could be corrected.
        {
          id: 'inventory',
          kind: 'observation',
          document: { complete: false },
          inventory: true,
        },
        { id: 'old', kind: 'observation', document: { record: 'invalid' } },
        { id: 'receipt', kind: 'acceptance', document: { adjustmentId: 'x' } },
      ]),
      'tenant',
      ['read', 'inventory', 'old', 'receipt'],
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        record: null,
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion: null,
        completeness: 'partial',
      }),
      expect.objectContaining({ id: 'inventory', completeness: null }),
      expect.objectContaining({ record: null, completeness: null }),
      expect.objectContaining({
        kind: 'write_receipt',
        capability: null,
        records: [],
        adapterVersion: null,
        dispatchIdentity: null,
      }),
    ]);
  });
});
