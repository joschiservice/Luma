import { describe, expect, it } from 'vitest';

import type { CollectionWhere } from '../../application/collections.js';
import { SqlParameters } from './parameters.js';
import { type CollectionFieldMap, compileWhere } from './where.js';

const fields: CollectionFieldMap = {
  status: { type: 'enum', sql: 'o.status' },
  name: { type: 'text', sql: 'o.name' },
  count: { type: 'number', sql: 'o.count', unknown: 'o.count_unread' },
  total: { type: 'money', sql: 'o.amount', currency: 'o.currency' },
  placed: { type: 'date', sql: 'o.placed_at' },
  late: { type: 'boolean', sql: 'o.late' },
  owner: { type: 'person', sql: 'o.owner_id' },
  tags: { type: 'tags', sql: 'o.tags' },
  location: { type: 'reference', sql: 'o.location_id', cast: 'uuid' },
  either: { type: 'boolean', sql: 'o.held OR o.late' },
  related: {
    type: 'reference',
    requires: ['links'],
    predicate: () => 'o.id IN (SELECT id FROM links)',
  },
};

function compile(
  where: Partial<CollectionWhere> & Pick<CollectionWhere, 'conditions'>,
  now = '2026-10-13T10:00:00Z',
  timeZone = 'UTC',
) {
  const values: unknown[] = ['tenant'];
  const result = compileWhere({ match: 'all', ...where }, fields, {
    parameters: new SqlParameters(values),
    now: new Date(now),
    timeZone,
    userId: 'user-1',
  });

  return { ...result, values };
}

describe('collection conditions', () => {
  it('binds every value as a parameter after the existing ones', () => {
    const { sql, values } = compile({
      conditions: [
        { field: 'status', op: 'any_of', value: ['open', "x' OR true --"] },
      ],
    });

    expect(sql).toBe('((o.status = ANY($2::text[])))');
    expect(values).toEqual(['tenant', ['open', "x' OR true --"]]);
  });

  it('combines conditions with AND or OR', () => {
    const conditions = [
      { field: 'late', op: 'is' as const, value: true },
      { field: 'status', op: 'any_of' as const, value: ['open'] },
    ];

    expect(compile({ conditions }).sql).toBe(
      '((o.late) AND (o.status = ANY($2::text[])))',
    );
    expect(compile({ match: 'any', conditions }).sql).toBe(
      '((o.late) OR (o.status = ANY($2::text[])))',
    );
    expect(
      compile({ conditions: [{ field: 'late', op: 'is', value: false }] }).sql,
    ).toBe('((o.late = $2::boolean))');
    expect(compile({ conditions: [] }).sql).toBe('true');
  });

  it('keeps unknown values out of comparisons, empty and negative operators', () => {
    const eq = compile({
      conditions: [{ field: 'count', op: 'eq', value: 0 }],
    });
    expect(eq.sql).toBe(
      '((NOT COALESCE((o.count_unread),false) AND (o.count = $2::numeric)))',
    );
    expect(
      compile({ conditions: [{ field: 'count', op: 'empty' }] }).sql,
    ).toContain('NOT COALESCE((o.count_unread),false) AND (o.count IS NULL)');
    expect(
      compile({ conditions: [{ field: 'count', op: 'unknown' }] }).sql,
    ).toBe('(COALESCE((o.count_unread),false))');
    expect(() =>
      compile({ conditions: [{ field: 'status', op: 'unknown' }] }),
    ).toThrow('This field does not support this operator');
  });

  it('lets negative operators match empty values but not comparisons', () => {
    expect(
      compile({
        conditions: [{ field: 'status', op: 'none_of', value: ['open'] }],
      }).sql,
    ).toContain('o.status IS NULL OR o.status <> ALL($2::text[])');
    expect(
      compile({ conditions: [{ field: 'count', op: 'ne', value: 3 }] }).sql,
    ).toContain('o.count <> $2::numeric');
  });

  it('compares money only within the named currency', () => {
    const { sql, values } = compile({
      conditions: [
        {
          field: 'total',
          op: 'gte',
          value: { amount: '100.50', currency: 'EUR' },
        },
      ],
    });

    expect(sql).toContain('o.currency = $2::text AND o.amount >= $3::numeric');
    expect(values.slice(1)).toEqual(['EUR', '100.50']);
    expect(() =>
      compile({
        conditions: [
          {
            field: 'total',
            op: 'between',
            value: {
              from: { amount: '1', currency: 'EUR' },
              to: { amount: '2', currency: 'USD' },
            },
          },
        ],
      }),
    ).toThrow('same currency');
    expect(() =>
      compile({ conditions: [{ field: 'total', op: 'gt', value: 5 }] }),
    ).toThrow('Amounts need a currency');
  });

  it('escapes LIKE wildcards in text conditions', () => {
    const { sql, values } = compile({
      conditions: [{ field: 'name', op: 'contains', value: '50%_off\\' }],
    });

    expect(sql).toContain('o.name ILIKE $2::text');
    expect(values[1]).toBe('%50\\%\\_off\\\\%');
  });

  it('resolves me to the caller', () => {
    const { values } = compile({
      conditions: [
        { field: 'owner', op: 'any_of', value: [{ dynamic: 'me' }] },
      ],
    });

    expect(values[1]).toEqual(['user-1']);
  });

  it('checks reference IDs and number values', () => {
    expect(() =>
      compile({
        conditions: [{ field: 'location', op: 'any_of', value: ['nope'] }],
      }),
    ).toThrow('valid record ID');
    expect(() =>
      compile({ conditions: [{ field: 'count', op: 'gt', value: 'many' }] }),
    ).toThrow('Expected a number');
    expect(() =>
      compile({ conditions: [{ field: 'missing', op: 'empty' }] }),
    ).toThrow('This field cannot be filtered');
    expect(() =>
      compile({ conditions: [{ field: 'toString', op: 'empty' }] }),
    ).toThrow('This field cannot be filtered');
  });

  it('compiles tags and custom field predicates with their query parts', () => {
    const result = compile({
      conditions: [
        { field: 'tags', op: 'all_of', value: ['a', 'b'] },
        { field: 'related', op: 'any_of', value: ['x'] },
      ],
    });

    expect(result.sql).toContain('o.tags @> $2::text[]');
    expect(result.sql).toContain('o.id IN (SELECT id FROM links)');
    expect([...result.requires]).toEqual(['links']);
  });

  describe('dates', () => {
    it('covers whole local days for day values', () => {
      // 2026-10-13 in Berlin runs from 2026-10-12T22:00Z to 2026-10-13T22:00Z.
      const { sql, values } = compile(
        {
          conditions: [
            {
              field: 'placed',
              op: 'between',
              value: { from: '2026-10-13', to: { dynamic: 'today' } },
            },
          ],
        },
        '2026-10-13T10:00:00Z',
        'Europe/Berlin',
      );

      expect(sql).toContain(
        'o.placed_at >= $2::timestamptz AND o.placed_at < $3::timestamptz',
      );
      expect(values.slice(1)).toEqual([
        '2026-10-12T22:00:00.000Z',
        '2026-10-13T22:00:00.000Z',
      ]);
    });

    it('treats before and after a day as outside that day', () => {
      const before = compile({
        conditions: [{ field: 'placed', op: 'before', value: '2026-10-13' }],
      });
      const after = compile({
        conditions: [{ field: 'placed', op: 'after', value: '2026-10-13' }],
      });

      expect(before.values[1]).toBe('2026-10-13T00:00:00.000Z');
      expect(before.sql).toContain('o.placed_at < $2');
      expect(after.values[1]).toBe('2026-10-14T00:00:00.000Z');
      expect(after.sql).toContain('o.placed_at >= $2');
    });

    it('compares exact instants strictly', () => {
      const { sql, values } = compile({
        conditions: [
          { field: 'placed', op: 'after', value: '2026-10-13T08:00:00+02:00' },
        ],
      });

      expect(sql).toContain('o.placed_at > $2::timestamptz');
      expect(values[1]).toBe('2026-10-13T06:00:00.000Z');
    });

    it('resolves relative periods across a daylight-saving change', () => {
      // Berlin leaves summer time on 2026-10-25; seven days before 2026-10-27 is 2026-10-20,
      // which starts at 22:00Z the previous day, while 2026-10-28 starts at 23:00Z.
      const last = compile(
        {
          conditions: [
            {
              field: 'placed',
              op: 'within_last',
              value: { amount: 7, unit: 'day' },
            },
          ],
        },
        '2026-10-27T12:00:00Z',
        'Europe/Berlin',
      );
      const next = compile(
        {
          conditions: [
            {
              field: 'placed',
              op: 'within_next',
              value: { amount: 0, unit: 'day' },
            },
          ],
        },
        '2026-10-27T12:00:00Z',
        'Europe/Berlin',
      );

      expect(last.sql).toContain(
        'o.placed_at >= $2::timestamptz AND o.placed_at <= $3::timestamptz',
      );
      expect(last.values.slice(1)).toEqual([
        '2026-10-19T22:00:00.000Z',
        '2026-10-27T12:00:00.000Z',
      ]);
      expect(next.values.slice(1)).toEqual([
        '2026-10-27T12:00:00.000Z',
        '2026-10-27T23:00:00.000Z',
      ]);
    });

    it('rejects malformed dates and periods', () => {
      expect(() =>
        compile({
          conditions: [{ field: 'placed', op: 'before', value: 'yesterday' }],
        }),
      ).toThrow('Dates need a day');
      expect(() =>
        compile({
          conditions: [{ field: 'placed', op: 'within_last', value: 3 }],
        }),
      ).toThrow('relative period');
    });
  });

  it('keeps operators from binding into a compound field expression', () => {
    expect(
      compile({ conditions: [{ field: 'either', op: 'is', value: false }] })
        .sql,
    ).toContain('(o.held OR o.late) = $2::boolean');
  });
});
