import { describe, expect, it } from 'vitest';

import {
  missingEvidence,
  resolveEvidence,
  type StoredEvidence,
  summarizeRead,
} from './evidence.js';

const start = '2026-10-01T00:00:00.000Z';
const connectionId = '00000000-0000-4000-8000-0000000000c1';

describe('summarizeRead', () => {
  it('keeps only allowlisted top-level fields and counts lists', () => {
    expect(
      summarizeRead({
        status: 'open',
        orderNumber: 'PO-1',
        confirmed: true,
        lines: [{}, {}],
        customer: { email: 'ada@example.com' },
        email: 'ada@example.com',
        note: 'private',
      }),
    ).toEqual([
      { field: 'status', value: 'open' },
      { field: 'orderNumber', value: 'PO-1' },
      { field: 'confirmed', value: 'true' },
      { field: 'lines', value: '2' },
    ]);
  });

  it('returns nothing for reads without fields', () => {
    expect(summarizeRead(null)).toEqual([]);
    expect(summarizeRead(['status'])).toEqual([]);
  });
});

describe('missingEvidence', () => {
  it('is not retained when a read or receipt was cited before storage began', () => {
    expect(
      missingEvidence(
        { ref: 'r', citedAs: 'read', citedAt: '2026-09-30T00:00:00Z' },
        start,
      ),
    ).toEqual({ kind: 'not_retained', retentionStartedAt: start });
  });

  it('stays unresolved after storage began, without a time or without a start', () => {
    expect(
      missingEvidence(
        { ref: 'r', citedAs: 'write_receipt', citedAt: '2026-10-02T00:00:00Z' },
        start,
      ),
    ).toEqual({ kind: 'unresolved' });
    expect(
      missingEvidence({ ref: 'r', citedAs: 'read', citedAt: null }, start),
    ).toEqual({ kind: 'unresolved' });
    expect(
      missingEvidence(
        { ref: 'r', citedAs: 'read', citedAt: '2026-09-30T00:00:00Z' },
        null,
      ),
    ).toEqual({ kind: 'unresolved' });
    expect(missingEvidence(undefined, start)).toEqual({ kind: 'unresolved' });
  });

  it('never explains away a missing Luma record', () => {
    expect(
      missingEvidence(
        { ref: 'r', citedAs: 'record', citedAt: '2026-09-30T00:00:00Z' },
        start,
      ),
    ).toEqual({ kind: 'unresolved' });
  });
});

describe('resolveEvidence', () => {
  const read: StoredEvidence = {
    kind: 'read',
    id: 'read-1',
    provider: 'jtl',
    connectionId,
    record: { resource: 'purchase_order', externalId: '42' },
    observedAt: '2026-10-03T10:00:00.000Z',
    sourceUpdatedAt: '2026-10-03T09:59:00.000Z',
    sourceRevision: '7',
    adapterVersion: 'jtl/3',
    completeness: 'partial',
    data: { status: 'open', supplierEmail: 'x@example.com' },
  };
  const receipt: StoredEvidence = {
    kind: 'write_receipt',
    id: 'receipt-1',
    provider: 'shopify',
    connectionId,
    capability: null,
    acceptedAt: '2026-10-03T09:58:00.000Z',
    records: [{ resource: 'return', externalId: 'gid://1' }],
    providerRequestId: 'req-1',
  };

  it('resolves each kind once in request order', () => {
    const items = resolveEvidence({
      refs: ['receipt-1', 'read-1', 'case-1', 'old', 'gone', 'read-1'],
      citations: [
        {
          ref: 'receipt-1',
          citedAs: 'write_receipt',
          citedAt: '2026-10-03T09:58:00Z',
          capability: 'returns.refund',
        },
        { ref: 'old', citedAs: 'read', citedAt: '2026-09-01T00:00:00Z' },
        { ref: 'gone', citedAs: 'read', citedAt: '2026-10-05T00:00:00Z' },
      ],
      found: [
        read,
        receipt,
        { kind: 'luma_record', id: 'case-1', record: 'return_case' },
      ],
      labels: new Map([[connectionId, 'Warehouse']]),
      start: () => start,
    });

    expect(items.map((item) => item.ref)).toEqual([
      'receipt-1',
      'read-1',
      'case-1',
      'old',
      'gone',
    ]);
    expect(items[0]).toMatchObject({
      citedAs: 'write_receipt',
      resolution: {
        kind: 'write_receipt',
        capability: 'returns.refund',
        connection: { id: connectionId, label: 'Warehouse' },
        providerRequestId: 'req-1',
      },
    });
    expect(items[1]?.resolution).toEqual({
      kind: 'read',
      provider: 'jtl',
      connection: { id: connectionId, label: 'Warehouse' },
      record: { resource: 'purchase_order', externalId: '42' },
      observedAt: '2026-10-03T10:00:00.000Z',
      sourceUpdatedAt: '2026-10-03T09:59:00.000Z',
      sourceRevision: '7',
      completeness: 'partial',
      adapterVersion: 'jtl/3',
      summary: [{ field: 'status', value: 'open' }],
    });
    expect(items[2]?.resolution).toEqual({
      kind: 'luma_record',
      record: 'return_case',
      id: 'case-1',
    });
    expect(items[3]?.resolution).toEqual({
      kind: 'not_retained',
      retentionStartedAt: start,
    });
    expect(items[4]?.resolution).toEqual({ kind: 'unresolved' });
  });

  it('decides retention by the earliest citation and prefers stored evidence to a record', () => {
    const [item] = resolveEvidence({
      refs: ['r'],
      citations: [
        { ref: 'r', citedAs: 'read', citedAt: '2026-10-09T00:00:00Z' },
        { ref: 'r', citedAs: 'read', citedAt: '2026-09-09T00:00:00Z' },
      ],
      found: [],
      labels: new Map(),
      start: () => start,
    });
    expect(item?.resolution.kind).toBe('not_retained');

    const [both] = resolveEvidence({
      refs: ['read-1'],
      citations: [],
      found: [{ kind: 'luma_record', id: 'read-1', record: 'case' }, read],
      labels: new Map(),
      start: () => null,
    });
    expect(both?.resolution).toMatchObject({
      kind: 'read',
      connection: { label: null },
    });
  });
});
