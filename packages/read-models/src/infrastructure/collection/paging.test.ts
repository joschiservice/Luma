import { describe, expect, it } from 'vitest';

import {
  collectionCursorContext,
  readCollectionCursor,
  writeCollectionCursor,
} from './cursor.js';
import { groupMemberPredicate, groupResults } from './group.js';
import { keysetCandidates, sortColumns, sortOrder } from './keyset.js';
import { SqlParameters } from './parameters.js';

const ordering = {
  sort: {
    present: 'o.amount IS NOT NULL',
    missing: 'o.amount IS NULL',
    keys: [
      { sql: 'o.currency', cast: 'text' as const },
      { sql: 'o.amount', cast: 'numeric' as const },
    ],
  },
  direction: 'desc' as const,
  id: 'o.id',
};

function context(values: unknown[] = []) {
  return {
    parameters: new SqlParameters(values),
    now: new Date('2026-10-13T10:00:00Z'),
    timeZone: 'Europe/Berlin',
    userId: 'user-1',
  };
}

describe('collection keyset paging', () => {
  it('orders missing values last in both directions', () => {
    expect(sortOrder(ordering)).toBe(
      '(o.amount IS NULL),o.currency desc,o.amount desc,o.id desc',
    );
    expect(sortOrder({ ...ordering, direction: 'asc' })).toBe(
      '(o.amount IS NULL),o.currency asc,o.amount asc,o.id asc',
    );
    expect(sortColumns(ordering)).toContain(
      'ARRAY[(o.currency)::text,(o.amount)::text]::text[] AS sort_keys',
    );
  });

  it('leaves out the rank of sorts that always have a value', () => {
    const always = {
      sort: {
        present: 'true',
        missing: 'false',
        keys: [{ sql: 'o.rank', cast: 'integer' as const }],
      },
      direction: 'asc' as const,
      id: 'o.id',
    };

    expect(sortOrder(always)).toBe('o.rank asc,o.id asc');
  });

  it('seeks rows with values by key tuple and rows without by ID', () => {
    const sql = keysetCandidates('filtered', ordering, '$10', {
      rank: '$11::int',
      keys: '$12::text[]',
      id: '$13::uuid',
    });

    expect(sql).toContain(
      '(o.currency,o.amount,o.id) < (($12::text[])[1]::text,($12::text[])[2]::numeric,$13::uuid)',
    );
    expect(sql).toContain('($11::int=1 AND o.id < $13::uuid)');
    expect(sql).toContain(
      'ORDER BY o.currency desc,o.amount desc,o.id desc LIMIT $10',
    );
  });

  it('binds cursors to their exact query, regardless of property order', () => {
    const scope = collectionCursorContext('v1', 'tenant', {
      sort: 'total',
      where: { match: 'all', conditions: [] },
      group: undefined,
    });
    const same = collectionCursorContext('v1', 'tenant', {
      where: { conditions: [], match: 'all' },
      sort: 'total',
    });
    const cursor = writeCollectionCursor(scope, {
      rank: 0,
      keys: ['EUR', '12.50'],
      id: 'row-1',
    });

    expect(same).toBe(scope);
    expect(readCollectionCursor(cursor, same, 'Start over')).toEqual({
      rank: 0,
      keys: ['EUR', '12.50'],
      id: 'row-1',
    });
    expect(() =>
      readCollectionCursor(
        cursor,
        collectionCursorContext('v1', 'other', { sort: 'total' }),
        'Start over',
      ),
    ).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Start over' }),
    );
    expect(() => readCollectionCursor('%%%', scope, 'Start over')).toThrow(
      'Start over',
    );
  });
});

describe('collection groups', () => {
  it('pages within a date group by its local period', () => {
    const values: unknown[] = [];
    const sql = groupMemberPredicate(
      {
        field: { date: 'o.placed_at', cast: 'timestamptz', order: 'asc' },
        granularity: 'week',
      },
      '2026-10-19',
      context(values),
    );

    expect(sql).toBe(
      'o.placed_at >= $1::timestamptz AND o.placed_at < $2::timestamptz',
    );
    // The week of 2026-10-19 spans the end of summer time in Berlin.
    expect(values).toEqual([
      '2026-10-18T22:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
    ]);
  });

  it('pages within scalar, multi-valued and empty groups', () => {
    const field = {
      key: 'o.status',
      cast: 'text' as const,
      order: 'asc' as const,
    };

    expect(groupMemberPredicate({ field }, 'open', context())).toBe(
      '(o.status)=$1::text',
    );
    expect(groupMemberPredicate({ field }, null, context())).toBe(
      '(o.status) IS NULL',
    );
    expect(
      groupMemberPredicate(
        {
          field: {
            keys: 'SELECT s.id AS key FROM sources s',
            cast: 'uuid',
            order: 'asc',
          },
        },
        null,
        context(),
      ),
    ).toBe('NOT EXISTS (SELECT s.id AS key FROM sources s)');
    expect(() =>
      groupMemberPredicate(
        { field: { key: 'o.late', cast: 'boolean', order: 'true_first' } },
        'yes',
        context(),
      ),
    ).toThrow('This group does not exist');
  });

  it('continues a group only when it has more rows than its head', () => {
    const head = [
      { id: 'a', rank: 0 as const, keys: ['1'] },
      { id: 'b', rank: 0 as const, keys: ['2'] },
    ];
    const { groups, truncated } = groupResults(
      [
        { key: 'open', count: 5, head, sums: [] },
        { key: null, count: 2, head, sums: [] },
        { key: 'closed', count: 1, head: head.slice(0, 1), sums: [] },
      ],
      2,
      true,
      (key, last) => `${String(key)}:${last.id}`,
    );

    expect(truncated).toBe(true);
    expect(groups.map((group) => [group.key, group.nextCursor])).toEqual([
      ['open', 'open:b'],
      [null, null],
    ]);
    expect(groups[0]).toMatchObject({
      count: 5,
      complete: true,
      itemIds: ['a', 'b'],
    });
  });
});
