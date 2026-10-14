import { describe, expect, it } from 'vitest';

import type { PurchaseOrder } from '../domain/procurement.js';
import { comparePositions, type OrderSummary } from './lists.js';
import {
  derivedKeyComparator,
  derivedPosition,
  groupMember,
  groupPurchaseOrders,
  maxGroups,
  type PositionedRow,
  purchaseOrderGroupField,
  type PurchaseOrderRow,
} from './purchase-order-list.js';

const id = (n: number) =>
  `1b7a2c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;

const purchaseOrder = (n: number, patch: Partial<PurchaseOrder> = {}) =>
  ({
    id: id(n),
    tenantId: 'tenant',
    supplierId: id(900),
    supplierName: 'Zephyr',
    reference: `PO-${n}`,
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [],
    status: 'draft',
    revision: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...patch,
  }) satisfies PurchaseOrder;

const summary = (n: number, patch: Partial<OrderSummary> = {}) =>
  ({
    id: id(n),
    stage: 'draft',
    expectedDate: null,
    attention: 0,
    attentionKinds: [],
    overdue: false,
    nextOwner: 'buyer',
    externalOrderNumber: null,
    confirmationDueAt: null,
    nextCheckAt: null,
    value: null,
    ...patch,
  }) satisfies OrderSummary;

const row = (
  n: number,
  order: Partial<PurchaseOrder> = {},
  progress: Partial<OrderSummary> = {},
): PurchaseOrderRow => ({
  order: purchaseOrder(n, order),
  summary: summary(n, progress),
});

const sorted = (
  rows: PurchaseOrderRow[],
  sort: 'value' | 'expected' | 'nextCheck',
  direction: 'asc' | 'desc',
) =>
  rows
    .map((item) => ({ ...item, position: derivedPosition(item, sort) }))
    .sort((a, b) =>
      comparePositions(
        a.position,
        b.position,
        direction,
        derivedKeyComparator(sort),
      ),
    )
    .map((item) => item.order.reference);

describe('purchase-order sorts in memory', () => {
  const rows = [
    row(1, {}, { value: { amount: '9.5', currency: 'EUR' } }),
    row(2, {}, { value: { amount: '10', currency: 'EUR' } }),
    row(3, {}, { value: 'unknown' }),
    row(4, {}, { value: { amount: '100', currency: 'CHF' } }),
    row(5),
  ];

  it('orders amounts numerically within a currency, missing values last', () => {
    expect(sorted(rows, 'value', 'asc')).toEqual([
      'PO-4',
      'PO-1',
      'PO-2',
      'PO-3',
      'PO-5',
    ]);
    expect(sorted(rows, 'value', 'desc')).toEqual([
      'PO-2',
      'PO-1',
      'PO-4',
      'PO-5',
      'PO-3',
    ]);
  });

  it('orders dates as instants and calendar days, missing last, ties by ID', () => {
    const dated = [
      row(1, {}, { expectedDate: '2026-10-20' }),
      row(2, {}, { expectedDate: '2026-10-18' }),
      row(3),
      row(4, {}, { expectedDate: '2026-10-18' }),
    ];
    expect(sorted(dated, 'expected', 'asc')).toEqual([
      'PO-2',
      'PO-4',
      'PO-1',
      'PO-3',
    ]);
    expect(sorted(dated, 'expected', 'desc')).toEqual([
      'PO-1',
      'PO-4',
      'PO-2',
      'PO-3',
    ]);
  });
});

describe('purchase-order groups', () => {
  const positioned = (rows: PurchaseOrderRow[]): PositionedRow[] =>
    rows.map((item) => ({
      ...item,
      position: { rank: 0, keys: [item.order.createdAt], id: item.order.id },
    }));

  it('counts every match and returns each group’s first rows in option order', () => {
    const rows = positioned([
      row(
        1,
        {},
        { stage: 'received', value: { amount: '5', currency: 'EUR' } },
      ),
      row(
        2,
        {},
        { stage: 'draft', value: { amount: '1.25', currency: 'EUR' } },
      ),
      row(3, {}, { stage: 'draft', value: { amount: '2', currency: 'USD' } }),
      row(4, {}, { stage: 'draft', value: 'unknown' }),
      row(5, {}, { stage: 'confirmed' }),
    ]);
    const cursors: [unknown, string][] = [];
    const result = groupPurchaseOrders(
      rows,
      purchaseOrderGroupField('stage'),
      2,
      (key, last) => {
        cursors.push([key, last.id]);

        return `cursor:${String(key)}`;
      },
    );
    expect(result.groups.map((group) => [group.key, group.count])).toEqual([
      ['draft', 3],
      ['confirmed', 1],
      ['received', 1],
    ]);
    expect(result.groups[0]).toMatchObject({
      complete: true,
      itemIds: [id(2), id(3)],
      nextCursor: 'cursor:draft',
      sums: [
        { field: 'value', currency: 'EUR', amount: '1.25' },
        { field: 'value', currency: 'USD', amount: '2' },
      ],
    });
    expect(result.groups[1]?.nextCursor).toBeNull();
    expect(cursors).toEqual([['draft', id(3)]]);
    expect(result.items.map((item) => item.order.id)).toEqual([
      id(2),
      id(3),
      id(5),
      id(1),
    ]);
    expect(result.truncated).toBe(false);
  });

  it('orders suppliers by name, then ID, and reports more than 50 groups', () => {
    const rows = positioned(
      Array.from({ length: maxGroups + 1 }, (_, n) =>
        row(n, {
          supplierId: id(500 + n),
          supplierName: n === 0 ? 'beta' : n === 1 ? 'Alpha' : `Zed ${n}`,
        }),
      ),
    );
    const result = groupPurchaseOrders(
      rows,
      purchaseOrderGroupField('supplier'),
      10,
      () => 'cursor',
    );
    expect(result.groups).toHaveLength(maxGroups);
    expect(result.truncated).toBe(true);
    expect(result.groups.slice(0, 2).map((group) => group.key)).toEqual([
      id(501),
      id(500),
    ]);
  });

  it('selects one group and rejects keys that cannot belong to the field', () => {
    const supplier = purchaseOrderGroupField('supplier');
    const member = groupMember(supplier, id(900).toUpperCase());
    expect(member(row(1))).toBe(true);
    expect(member(row(2, { supplierId: id(901) }))).toBe(false);
    expect(() => groupMember(supplier, 'not-an-id')).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => groupMember(purchaseOrderGroupField('stage'), 3)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => purchaseOrderGroupField('expected')).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'This field cannot be grouped.',
      }),
    );
  });
});
