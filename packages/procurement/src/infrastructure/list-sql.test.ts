import { describe, expect, it } from 'vitest';

import { type StoredFieldSql, storedWhereSql } from './list-sql.js';

const fields: Readonly<Record<string, StoredFieldSql>> = {
  count: { kind: 'value', sql: 'o.count', cast: 'numeric' },
  due: { kind: 'value', sql: 'o.due', cast: 'date' },
  labels: { kind: 'set', sql: 'o.labels' },
};

function compile(conditions: Parameters<typeof storedWhereSql>[0]) {
  const values: unknown[] = [];
  const sql = storedWhereSql(conditions, fields, (value, cast) => {
    values.push(value);

    return `$${values.length}::${cast}`;
  });

  return { sql, values };
}

describe('stored list SQL', () => {
  it('compares numbers so rows without a value never match', () => {
    expect(
      compile({
        match: 'all',
        conditions: [
          {
            field: 'count',
            op: 'compare',
            comparisons: [
              { op: 'gte', value: '2' },
              { op: 'lte', value: '5' },
            ],
          },
        ],
      }),
    ).toEqual({
      sql: '((COALESCE(o.count >= $1::numeric AND o.count <= $2::numeric,false)))',
      values: ['2', '5'],
    });
  });

  it('binds calendar-day ranges as dates', () => {
    expect(
      compile({
        match: 'all',
        conditions: [
          {
            field: 'due',
            op: 'range',
            from: { at: '2026-10-01', inclusive: false },
            to: null,
          },
        ],
      }),
    ).toEqual({ sql: '((o.due > $1::date))', values: ['2026-10-01'] });
  });

  it('matches sets of values, where negative operators match empty sets', () => {
    expect(
      compile({
        match: 'any',
        conditions: [
          { field: 'labels', op: 'all_of', values: ['eu', 'urgent'] },
          { field: 'labels', op: 'none_of', values: ['eu'] },
          { field: 'labels', op: 'empty' },
        ],
      }).sql,
    ).toBe(
      '((o.labels @> $1::text[]) OR (NOT (o.labels && $2::text[])) OR (cardinality(o.labels)=0))',
    );
  });
});
