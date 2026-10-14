import { describe, expect, it } from 'vitest';

import {
  comparePositions,
  type ListPosition,
  purchaseOrderDirection,
  readListCursor,
  supplierDirection,
  writeListCursor,
} from './lists.js';

const ids = [
  '1b7a2c1e-0000-4000-8000-000000000001',
  '1b7a2c1e-0000-4000-8000-000000000002',
  '1b7a2c1e-0000-4000-8000-000000000003',
];

describe('procurement list cursors', () => {
  it('round-trip within the issuing query and keep the first page time', () => {
    const cursor = writeListCursor(
      'scope',
      { rank: 0, keys: ['2026-10-20'], id: ids[0]! },
      '2026-10-13T08:00:00.000Z',
    );

    expect(readListCursor(cursor, 'scope', 'purchase order', true)).toEqual({
      rank: 0,
      keys: ['2026-10-20'],
      id: ids[0],
      asOf: '2026-10-13T08:00:00.000Z',
    });
  });

  it('reject other queries, malformed positions and missing evaluation times', () => {
    const position: ListPosition = { rank: 0, keys: ['a'], id: ids[0]! };
    const rejected = expect.objectContaining({
      statusCode: 400,
      message:
        'This page link no longer matches the purchase order filters. Start from the first page.',
    });

    expect(() =>
      readListCursor(
        writeListCursor('other', position),
        'scope',
        'purchase order',
      ),
    ).toThrow(rejected);
    expect(() =>
      readListCursor(
        writeListCursor('scope', position),
        'scope',
        'purchase order',
        true,
      ),
    ).toThrow(rejected);
    for (const value of [
      'not-a-cursor',
      writeListCursor('scope', { rank: 0, keys: null, id: ids[0]! }),
      writeListCursor('scope', { ...position, id: 'not-a-uuid' }),
    ])
      expect(() => readListCursor(value, 'scope', 'purchase order')).toThrow(
        rejected,
      );
  });
});

describe('procurement list order', () => {
  it('puts rows without a value last in both directions', () => {
    const rows: ListPosition[] = [
      { rank: 1, keys: null, id: ids[0]! },
      { rank: 0, keys: ['2026-10-20'], id: ids[1]! },
      { rank: 0, keys: ['2026-10-18'], id: ids[2]! },
    ];
    const sorted = (direction: 'asc' | 'desc') =>
      [...rows]
        .sort((a, b) => comparePositions(a, b, direction))
        .map((row) => row.id);

    expect(sorted('asc')).toEqual([ids[2], ids[1], ids[0]]);
    expect(sorted('desc')).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('defaults to newest first for dates and alphabetical order otherwise', () => {
    expect(purchaseOrderDirection({ sort: 'created' })).toBe('desc');
    expect(purchaseOrderDirection({ sort: 'updated' })).toBe('desc');
    expect(purchaseOrderDirection({ sort: 'expected' })).toBe('asc');
    expect(purchaseOrderDirection({ sort: 'reference' })).toBe('asc');
    expect(
      purchaseOrderDirection({ sort: 'supplier', direction: 'desc' }),
    ).toBe('desc');
    expect(supplierDirection({ sort: 'name' })).toBe('asc');
    expect(supplierDirection({ sort: 'orders' })).toBe('desc');
  });
});
