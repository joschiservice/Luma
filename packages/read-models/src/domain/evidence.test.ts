import { describe, expect, it } from 'vitest';

import {
  capabilityReadPermission,
  evidenceActor,
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

  it('presents record facts with their actor, messages without text, and restricted evidence', () => {
    const member = '00000000-0000-4000-8000-0000000000e1';
    const items = resolveEvidence({
      refs: ['event', 'message', 'guarded', 'note'],
      citations: [],
      found: [
        {
          kind: 'luma_record',
          id: 'event',
          record: 'procurement_event',
          at: '2026-10-02T00:00:00.000Z',
          actorId: member.toUpperCase(),
          detail: {
            kind: 'procurement_event',
            event: 'status_changed',
            from: 'draft',
            to: 'open',
            revision: 2,
          },
        },
        {
          kind: 'message',
          id: 'message',
          provider: 'gmail',
          connectionId,
          direction: 'outbound',
          sender: { address: 'buying@shop.example', name: null },
          receivedAt: '2026-10-02T00:00:00.000Z',
          subject: 'x'.repeat(400),
          senderAuthentication: 'aligned',
        },
        { kind: 'restricted', id: 'guarded', permission: 'messages.read' },
        {
          kind: 'luma_record',
          id: 'note',
          record: 'receipt_note',
          recordId: 'commitment-1',
        },
      ],
      labels: new Map([[connectionId, 'Purchasing inbox']]),
      people: new Map([
        [
          member,
          {
            id: member,
            name: 'Mara',
            email: 'mara@example.test',
            member: true,
          },
        ],
      ]),
      start: () => null,
    });
    expect(items.map((item) => item.resolution)).toEqual([
      {
        kind: 'luma_record',
        record: 'procurement_event',
        id: 'event',
        at: '2026-10-02T00:00:00.000Z',
        actor: {
          kind: 'member',
          id: member.toUpperCase(),
          name: 'Mara',
          email: 'mara@example.test',
          workflow: null,
        },
        detail: {
          kind: 'procurement_event',
          event: 'status_changed',
          from: 'draft',
          to: 'open',
          revision: 2,
        },
      },
      expect.objectContaining({
        kind: 'message',
        connection: { id: connectionId, label: 'Purchasing inbox' },
        subject: 'x'.repeat(300),
      }),
      { kind: 'restricted', permission: 'messages.read' },
      { kind: 'luma_record', record: 'receipt_note', id: 'commitment-1' },
    ]);
  });

  it('prefers stored evidence and records to a restricted placeholder for the same reference', () => {
    const [item] = resolveEvidence({
      refs: ['r'],
      citations: [],
      found: [
        { kind: 'restricted', id: 'r', permission: 'inventory.read' },
        { kind: 'luma_record', id: 'r', record: 'ledger_entry' },
      ],
      labels: new Map(),
      start: () => null,
    });
    expect(item?.resolution).toEqual({
      kind: 'luma_record',
      record: 'ledger_entry',
      id: 'r',
    });
  });
});

describe('evidenceActor', () => {
  const people = new Map([
    [
      '00000000-0000-4000-8000-0000000000e2',
      {
        id: '00000000-0000-4000-8000-0000000000e2',
        name: 'Former',
        email: 'former@example.test',
        member: false,
      },
    ],
  ]);

  it('names Luma, services, former members and unrecorded actors', () => {
    expect(evidenceActor(undefined, people)).toBeUndefined();
    expect(evidenceActor(null, people)?.kind).toBe('unrecorded');
    expect(
      evidenceActor('00000000-0000-0000-0000-000000000000', people)?.kind,
    ).toBe('luma');
    expect(evidenceActor('jtl-sync', people)).toMatchObject({
      kind: 'service',
      name: 'jtl-sync',
    });
    // Former members keep their name but never their email.
    expect(
      evidenceActor('00000000-0000-4000-8000-0000000000e2', people),
    ).toMatchObject({ kind: 'former_member', name: 'Former', email: null });
    expect(
      evidenceActor('00000000-0000-4000-8000-0000000000e3', people),
    ).toMatchObject({ kind: 'former_member', name: null });
  });
});

describe('capabilityReadPermission', () => {
  it('reads the permission of the capability area', () => {
    expect(capabilityReadPermission('inventory.available.reconcile')).toBe(
      'inventory.read',
    );
    expect(capabilityReadPermission('orders.quantity.edit')).toBe(
      'orders.read',
    );
    expect(capabilityReadPermission('fulfillment.hold.release')).toBe(
      'fulfillment.read',
    );
    expect(capabilityReadPermission('purchase-orders.submit')).toBeNull();
    expect(capabilityReadPermission('toString')).toBeNull();
  });
});
