import { describe, expect, it } from 'vitest';

import {
  listKeyset,
  listScope,
  positionOf,
  readListCursor,
  writeListCursor,
} from './list-paging.js';

const id = '5f0f4c2e-8d4b-4a51-9c1e-3f2a6b7c8d90';
const other = '0b6f1f43-6a55-4c2c-a1d1-7a1c2b3d4e5f';

describe('list cursors', () => {
  it('continue only the tenant, filters and sort that issued them', () => {
    const scope = listScope('inventory-v2', 'tenant-a', ['q', 'sku', 'asc']);
    const cursor = writeListCursor(
      scope,
      { rank: 0, keys: ['SKU-1', 'Main'], ids: [id] },
      '2026-10-13T00:00:00.000Z',
    );

    expect(readListCursor(cursor, scope, 'inventory')).toEqual({
      rank: 0,
      keys: ['SKU-1', 'Main'],
      ids: [id],
      asOf: '2026-10-13T00:00:00.000Z',
    });
    for (const changed of [
      listScope('inventory-v2', 'tenant-b', ['q', 'sku', 'asc']),
      listScope('inventory-v2', 'tenant-a', ['q', 'sku', 'desc']),
    ])
      expect(() => readListCursor(cursor, changed, 'inventory')).toThrow(
        expect.objectContaining({
          statusCode: 400,
          message:
            'This page link no longer matches the inventory filters. Start from the first page.',
        }),
      );
  });

  it('rejects malformed cursors and positions with a value but no keys', () => {
    const scope = listScope('products-v2', 'tenant', []);

    for (const value of [
      'not-a-cursor',
      `${writeListCursor(scope, { rank: 0, keys: ['a'], ids: [id] })}=`,
      Buffer.from(
        JSON.stringify({ context: scope, rank: 0, keys: null, ids: [id] }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({ context: scope, rank: 2, keys: null, ids: [id] }),
      ).toString('base64url'),
    ])
      expect(() => readListCursor(value, scope, 'product')).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
  });
});

describe('list keysets', () => {
  const order = {
    keys: [
      { sql: 'c.currency', type: 'text' as const },
      { sql: 'c.amount', type: 'numeric' as const },
    ],
    ids: ['c.id'],
  };

  it('orders missing values last and compares keys and identity in the sort direction', () => {
    const values: unknown[] = ['tenant'];
    const keyset = listKeyset(
      { ...order, direction: 'desc' },
      { rank: 0, keys: ['EUR', '12.50'], ids: [id] },
      values,
    );

    expect(keyset.orderBy).toBe(
      'c.currency DESC NULLS LAST,c.amount DESC,c.id DESC',
    );
    expect(keyset.predicate).toBe(
      '(((c.currency) IS NULL) OR (c.currency,c.amount,c.id) < ($3::text,$4::numeric,$2::uuid))',
    );
    expect(values).toEqual(['tenant', id, 'EUR', '12.50']);
  });

  it('pages rows without a value by identity only', () => {
    const values: unknown[] = [];
    const keyset = listKeyset(
      { ...order, direction: 'asc' },
      { rank: 1, keys: null, ids: [id] },
      values,
    );

    expect(keyset.predicate).toBe(
      '(((c.currency) IS NULL) AND (c.id) > ($1::uuid))',
    );
    expect(keyset.position).toBe(
      '((c.currency) IS NULL) AS list_rank,CASE WHEN ((c.currency) IS NULL) THEN NULL ELSE ARRAY[(c.currency)::text,(c.amount)::text] END AS list_keys',
    );
  });

  it('keeps comparing keys among missing rows when the order names its missing condition', () => {
    const values: unknown[] = [];
    const keyset = listKeyset(
      {
        keys: [
          {
            sql: 'COALESCE(c.deadline_at,c.progress_at)',
            type: 'timestamptz',
          },
        ],
        ids: ['c.entity_id', 'c.connection_id'],
        missing: 'c.deadline_at IS NULL',
        direction: 'asc',
      },
      {
        rank: 1,
        keys: ['2026-10-13 00:00:00+00'],
        ids: [id, other],
      },
      values,
    );

    expect(keyset.predicate).toBe(
      '((c.deadline_at IS NULL) AND (COALESCE(c.deadline_at,c.progress_at),c.entity_id,c.connection_id) > ($3::timestamptz,$1::uuid,$2::uuid))',
    );
    expect(keyset.orderBy).toBe(
      '(c.deadline_at IS NULL),COALESCE(c.deadline_at,c.progress_at) ASC,c.entity_id ASC,c.connection_id ASC',
    );
  });

  it('matches a plain index when every row has a value', () => {
    const values: unknown[] = [];
    const keyset = listKeyset(
      {
        keys: [{ sql: 'r.requested_key', type: 'timestamptz' }],
        ids: ['r.entity_id'],
        direction: 'desc',
        missing: false,
      },
      { rank: 0, keys: ['2026-10-13 00:00:00+00'], ids: [id] },
      values,
    );

    expect(keyset.orderBy).toBe('r.requested_key DESC,r.entity_id DESC');
    expect(keyset.predicate).toBe(
      '(r.requested_key,r.entity_id) < ($2::timestamptz,$1::uuid)',
    );
    expect(() =>
      listKeyset(
        {
          keys: [{ sql: 'r.requested_key', type: 'timestamptz' }],
          ids: ['r.entity_id'],
          direction: 'desc',
          missing: false,
        },
        { rank: 1, keys: null, ids: [id] },
        [],
      ),
    ).toThrow();
  });

  it('rejects a cursor whose shape does not fit the order', () => {
    expect(() =>
      listKeyset(
        { ...order, direction: 'asc' },
        { rank: 0, keys: ['EUR'], ids: [id] },
        [],
      ),
    ).toThrow();
    expect(() =>
      listKeyset(
        { ...order, direction: 'asc' },
        { rank: 1, keys: null, ids: [id, other] },
        [],
      ),
    ).toThrow();
  });

  it('reads positions from selected rows', () => {
    expect(positionOf({ list_rank: true, list_keys: null }, [id])).toEqual({
      rank: 1,
      keys: null,
      ids: [id],
    });
    expect(positionOf({ list_rank: false, list_keys: ['a'] }, [id])).toEqual({
      rank: 0,
      keys: ['a'],
      ids: [id],
    });
  });
});
