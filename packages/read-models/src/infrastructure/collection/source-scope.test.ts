import { describe, expect, it } from 'vitest';

import type { CollectionCondition } from '../../application/collections.js';
import { SqlParameters } from './parameters.js';
import { SourceConditions } from './source-scope.js';
import { compileWhere } from './where.js';

const source = '6d5f0c1a-2b3c-4d5e-8f90-1a2b3c4d5e6f';

function compile(conditions: CollectionCondition[]) {
  const values: unknown[] = ['tenant'];
  const scoped = new SourceConditions('c.connection_id');
  const { sql } = compileWhere(
    { match: 'all', conditions },
    scoped.fields({
      available: {
        type: 'number',
        sql: 'c.available',
        lowest: 'min(c.available)',
      },
      tracked: { type: 'boolean', sql: 'c.tracked' },
    }),
    {
      parameters: new SqlParameters(values),
      now: new Date('2026-10-13T10:00:00Z'),
      timeZone: 'UTC',
      userId: 'user-1',
    },
  );

  return { sql, select: scoped.select(), values };
}

describe('source-scoped conditions', () => {
  it('match when any source matches by default and read the aggregate column', () => {
    const { sql, select, values } = compile([
      { field: 'available', op: 'lte', value: 0 },
    ]);

    expect(sql).toBe('((o.scoped_0))');
    expect(select).toBe(
      ',COALESCE(bool_or(((c.available <= $2::numeric))),false) AS scoped_0',
    );
    expect(values).toEqual(['tenant', 0]);
  });

  it('require every source to report a matching value', () => {
    expect(
      compile([{ field: 'available', op: 'lte', value: 0, source: 'every' }])
        .select,
    ).toBe(
      ',COALESCE(bool_and(COALESCE(((c.available <= $2::numeric)),false)),false) AS scoped_0',
    );
  });

  it('bind a named source and compare the lowest reported quantity', () => {
    const { select, values } = compile([
      { field: 'available', op: 'lt', value: 5, source },
      { field: 'available', op: 'lt', value: 5, source: 'lowest' },
    ]);

    expect(select).toBe(
      ',COALESCE(bool_or(((c.available < $2::numeric))) FILTER (WHERE c.connection_id=$3::uuid),false) AS scoped_0' +
        ',COALESCE(((min(c.available) < $4::numeric)),false) AS scoped_1',
    );
    expect(values).toEqual(['tenant', 5, source, 5]);
  });

  it('refuse the lowest value for anything but quantities', () => {
    expect(() =>
      compile([{ field: 'tracked', op: 'is', value: true, source: 'lowest' }]),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'Only quantities can use the lowest value of all sources',
      }),
    );
  });
});
