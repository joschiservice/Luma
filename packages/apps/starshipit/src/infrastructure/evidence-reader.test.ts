import type { SqlTransaction } from '@luma/platform';
import { describe, expect, it } from 'vitest';

import { readStarshipitEvidence } from './evidence-reader.js';

const observedAt = new Date('2026-10-17T10:00:00.000Z');

function transaction(rows: { id: string; document: unknown }[]) {
  return {
    query: async () => ({
      rows: rows.map((row) => ({
        ...row,
        connection_id: 'connection',
        observed_at: observedAt,
      })),
    }),
  } as unknown as SqlTransaction;
}

describe('Starshipit evidence reader', () => {
  it('returns the provenance new reads and acceptances recorded', async () => {
    const evidence = await readStarshipitEvidence(
      transaction([
        {
          id: 'read',
          document: {
            kind: 'observation',
            orderId: '1',
            revision: 'r1',
            adapterVersion: 'starshipit-update/1',
            completeness: 'complete',
            sourceUpdatedAt: null,
          },
        },
        {
          id: 'receipt',
          document: {
            kind: 'acceptance',
            operationId: 'operation',
            adapterVersion: 'starshipit-update/1',
            dispatchIdentity: 'starshipit:connection:starshipit-update/1',
            idempotencyKey: 'v0:1',
            records: [
              { resource: 'order', externalId: '1' },
              { resource: 'order_line', externalId: '11' },
            ],
          },
        },
      ]),
      'tenant',
      ['read', 'receipt'],
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: 'read',
        record: { resource: 'order', externalId: '1' },
        sourceRevision: 'r1',
        sourceUpdatedAt: null,
        adapterVersion: 'starshipit-update/1',
        completeness: 'complete',
      }),
      {
        kind: 'write_receipt',
        id: 'receipt',
        provider: 'starshipit',
        connectionId: 'connection',
        capability: null,
        acceptedAt: observedAt.toISOString(),
        records: [
          { resource: 'order', externalId: '1' },
          { resource: 'order_line', externalId: '11' },
        ],
        providerRequestId: null,
        adapterVersion: 'starshipit-update/1',
        dispatchIdentity: 'starshipit:connection:starshipit-update/1',
      },
    ]);
  });

  it('leaves fields older rows never recorded as null', async () => {
    const evidence = await readStarshipitEvidence(
      transaction([
        { id: 'read', document: { kind: 'observation', orderId: 7 } },
        { id: 'receipt', document: { kind: 'acceptance', operationId: 'o' } },
      ]),
      'tenant',
      ['read', 'receipt'],
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        record: { resource: 'order', externalId: '7' },
        sourceRevision: null,
        adapterVersion: null,
        completeness: null,
      }),
      expect.objectContaining({
        kind: 'write_receipt',
        records: [],
        adapterVersion: null,
        dispatchIdentity: null,
      }),
    ]);
  });
});
