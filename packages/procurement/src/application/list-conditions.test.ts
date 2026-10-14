import { describe, expect, it } from 'vitest';

import type { Amount } from '../domain/order-value.js';
import {
  type ListClock,
  type ListFields,
  planListWhere,
  type UnknownValue,
  unknownValue,
} from './list-conditions.js';
import type { ListCondition } from './lists.js';

interface Row {
  id: string;
  name: string | null;
  tags: string[];
  skus: string[];
  count: number | null;
  total: Amount | null | UnknownValue;
  at: string | null;
  day: string | null;
  flag: boolean | null | UnknownValue;
}

const fields: ListFields<Row> = {
  name: {
    kind: 'text',
    operators: [
      'contains',
      'not_contains',
      'is',
      'is_not',
      'empty',
      'not_empty',
    ],
    read: (row) => row.name,
  },
  tags: {
    kind: 'choices',
    operators: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'],
    read: (row) => row.tags,
  },
  skus: {
    kind: 'texts',
    operators: ['contains', 'not_contains', 'is', 'is_not'],
    read: (row) => row.skus,
  },
  count: {
    kind: 'number',
    operators: ['eq', 'ne', 'gt', 'between', 'empty'],
    read: (row) => row.count,
  },
  total: {
    kind: 'money',
    operators: ['eq', 'ne', 'gte', 'between', 'empty', 'not_empty', 'unknown'],
    read: (row) => row.total,
  },
  at: {
    kind: 'instant',
    operators: ['before', 'after', 'between', 'within_last', 'within_next'],
    read: (row) => row.at,
  },
  day: {
    kind: 'day',
    operators: ['before', 'after', 'between', 'within_last', 'within_next'],
    read: (row) => row.day,
  },
  flag: { kind: 'flag', operators: ['is', 'unknown'], read: (row) => row.flag },
  owner: {
    kind: 'choice',
    ids: true,
    operators: ['any_of', 'none_of'],
    stored: ['any_of', 'none_of'],
  },
};

const row = (patch: Partial<Row> & { id: string }): Row => ({
  name: null,
  tags: [],
  skus: [],
  count: null,
  total: null,
  at: null,
  day: null,
  flag: null,
  ...patch,
});

const rows: Row[] = [
  row({
    id: 'priced',
    name: 'Alpha',
    tags: ['a', 'b'],
    skus: ['TOTE-NAT', 'BAG'],
    count: 0,
    total: { amount: '100.50', currency: 'EUR' },
    at: '2026-10-12T22:30:00.000Z',
    day: '2026-10-13',
    flag: true,
  }),
  row({
    id: 'dollars',
    name: 'beta',
    tags: ['b'],
    skus: ['TOTE-BLK'],
    count: 3,
    total: { amount: '99', currency: 'USD' },
    at: '2026-10-05T10:00:00.000Z',
    day: '2026-10-20',
    flag: false,
  }),
  row({ id: 'unknown', total: unknownValue, flag: unknownValue }),
  row({ id: 'empty' }),
];

// 2026-10-13 00:30 in Berlin.
const clock: ListClock = {
  now: new Date('2026-10-12T22:30:00.000Z'),
  timeZone: 'Europe/Berlin',
};

const matching = (
  conditions: ListCondition[],
  match: 'all' | 'any' = 'all',
  at: ListClock = clock,
) => {
  const plan = planListWhere({ match, conditions }, fields, at);

  return rows
    .filter((item) => plan.memory?.(item) ?? true)
    .map((item) => item.id);
};

describe('list conditions in memory', () => {
  it('keeps empty and unknown values out of comparisons', () => {
    expect(matching([{ field: 'count', op: 'eq', value: 0 }])).toEqual([
      'priced',
    ]);
    expect(matching([{ field: 'count', op: 'ne', value: 0 }])).toEqual([
      'dollars',
    ]);
    expect(matching([{ field: 'count', op: 'empty' }])).toEqual([
      'unknown',
      'empty',
    ]);
    expect(
      matching([
        {
          field: 'total',
          op: 'ne',
          value: { amount: '1', currency: 'EUR' },
        },
      ]),
    ).toEqual(['priced']);
    expect(matching([{ field: 'total', op: 'empty' }])).toEqual(['empty']);
    expect(matching([{ field: 'total', op: 'not_empty' }])).toEqual([
      'priced',
      'dollars',
    ]);
    expect(matching([{ field: 'total', op: 'unknown' }])).toEqual(['unknown']);
    expect(matching([{ field: 'flag', op: 'is', value: false }])).toEqual([
      'dollars',
    ]);
    expect(matching([{ field: 'flag', op: 'unknown' }])).toEqual(['unknown']);
  });

  it('lets negative operators match empty values', () => {
    expect(
      matching([{ field: 'name', op: 'not_contains', value: 'ALP' }]),
    ).toEqual(['dollars', 'unknown', 'empty']);
    expect(matching([{ field: 'name', op: 'is_not', value: 'beta' }])).toEqual([
      'priced',
      'unknown',
      'empty',
    ]);
    expect(matching([{ field: 'name', op: 'is', value: 'Beta' }])).toEqual([]);
    expect(matching([{ field: 'tags', op: 'none_of', value: ['a'] }])).toEqual([
      'dollars',
      'unknown',
      'empty',
    ]);
  });

  it('matches tags like the order list and line values when any line does', () => {
    expect(matching([{ field: 'tags', op: 'any_of', value: ['a'] }])).toEqual([
      'priced',
    ]);
    expect(
      matching([{ field: 'tags', op: 'all_of', value: ['a', 'b'] }]),
    ).toEqual(['priced']);
    expect(matching([{ field: 'tags', op: 'empty' }])).toEqual([
      'unknown',
      'empty',
    ]);
    expect(
      matching([{ field: 'skus', op: 'contains', value: 'tote' }]),
    ).toEqual(['priced', 'dollars']);
    expect(
      matching([{ field: 'skus', op: 'not_contains', value: 'nat' }]),
    ).toEqual(['dollars', 'unknown', 'empty']);
    expect(matching([{ field: 'skus', op: 'is', value: 'BAG' }])).toEqual([
      'priced',
    ]);
  });

  it('compares amounts only within one currency', () => {
    expect(
      matching([
        {
          field: 'total',
          op: 'gte',
          value: { amount: '100.5', currency: 'EUR' },
        },
      ]),
    ).toEqual(['priced']);
    expect(
      matching([
        {
          field: 'total',
          op: 'between',
          value: { from: { amount: '90', currency: 'USD' }, to: null },
        },
      ]),
    ).toEqual(['dollars']);
    expect(() =>
      matching([
        {
          field: 'total',
          op: 'between',
          value: {
            from: { amount: '1', currency: 'USD' },
            to: { amount: '2', currency: 'EUR' },
          },
        },
      ]),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message:
          'Condition 1: Both ends of an amount range need the same currency.',
      }),
    );
  });

  it('resolves days, today and relative periods in the reader’s time zone', () => {
    // 22:30 UTC on the 12th is already the 13th in Berlin.
    expect(
      matching([
        {
          field: 'at',
          op: 'between',
          value: { from: { dynamic: 'today' }, to: { dynamic: 'today' } },
        },
      ]),
    ).toEqual(['priced']);
    expect(
      matching(
        [
          {
            field: 'at',
            op: 'between',
            value: { from: { dynamic: 'today' }, to: { dynamic: 'today' } },
          },
        ],
        'all',
        { ...clock, timeZone: 'UTC' },
      ),
    ).toEqual(['priced']);
    expect(
      matching([{ field: 'at', op: 'before', value: '2026-10-13' }]),
    ).toEqual(['dollars']);
    expect(
      matching([{ field: 'at', op: 'after', value: '2026-10-12' }]),
    ).toEqual(['priced']);
    expect(
      matching([{ field: 'at', op: 'after', value: '2026-10-12' }], 'all', {
        ...clock,
        timeZone: 'UTC',
      }),
    ).toEqual([]);
    expect(
      matching([
        { field: 'at', op: 'within_last', value: { amount: 7, unit: 'day' } },
      ]),
    ).toEqual(['priced']);
    expect(
      matching([
        { field: 'at', op: 'within_last', value: { amount: 8, unit: 'day' } },
      ]),
    ).toEqual(['priced', 'dollars']);
    expect(
      matching([{ field: 'at', op: 'before', value: '2026-10-12T22:30:00Z' }]),
    ).toEqual(['dollars']);
  });

  it('compares calendar days directly', () => {
    expect(
      matching([
        {
          field: 'day',
          op: 'between',
          value: { from: { dynamic: 'today' }, to: null },
        },
      ]),
    ).toEqual(['priced', 'dollars']);
    expect(
      matching([
        { field: 'day', op: 'within_next', value: { amount: 1, unit: 'week' } },
      ]),
    ).toEqual(['priced', 'dollars']);
    expect(
      matching([
        { field: 'day', op: 'within_next', value: { amount: 6, unit: 'day' } },
      ]),
    ).toEqual(['priced']);
    expect(
      matching([{ field: 'day', op: 'before', value: '2026-10-20' }]),
    ).toEqual(['priced']);
  });

  it('combines conditions with any', () => {
    expect(
      matching(
        [
          { field: 'count', op: 'gt', value: 1 },
          { field: 'flag', op: 'is', value: true },
        ],
        'any',
      ),
    ).toEqual(['priced', 'dollars']);
  });
});

describe('list condition plans', () => {
  const owner = '0b7a2c1e-0000-4000-8000-00000000000A';
  // The same fields when the store can apply some operators in SQL.
  const storedFields: ListFields<Row> = {
    ...fields,
    name: {
      kind: 'text',
      operators: ['contains', 'is'],
      stored: ['contains', 'is'],
      read: (row) => row.name,
    },
    at: {
      kind: 'instant',
      operators: ['before', 'within_last'],
      stored: ['before', 'within_last'],
      read: (row) => row.at,
    },
  };

  it('sends stored conditions to SQL and the rest to memory with match all', () => {
    const plan = planListWhere(
      {
        match: 'all',
        conditions: [
          { field: 'owner', op: 'any_of', value: [owner] },
          { field: 'at', op: 'before', value: '2026-10-13' },
          { field: 'count', op: 'gt', value: 1 },
        ],
      },
      storedFields,
      clock,
    );
    expect(plan.stored).toEqual({
      match: 'all',
      conditions: [
        { field: 'owner', op: 'any_of', values: [owner.toLowerCase()] },
        {
          field: 'at',
          op: 'range',
          from: null,
          to: { at: '2026-10-12T22:00:00.000Z', inclusive: false },
        },
      ],
    });
    expect(plan.memory).toBeTypeOf('function');
  });

  it('keeps match any in SQL only when every condition is stored', () => {
    expect(
      planListWhere(
        {
          match: 'any',
          conditions: [
            { field: 'name', op: 'contains', value: 'a' },
            {
              field: 'at',
              op: 'within_last',
              value: { amount: 1, unit: 'month' },
            },
          ],
        },
        storedFields,
        clock,
      ),
    ).toMatchObject({ stored: { match: 'any' }, memory: null });
    const mixed = planListWhere(
      {
        match: 'any',
        conditions: [
          { field: 'name', op: 'contains', value: 'a' },
          { field: 'count', op: 'gt', value: 1 },
        ],
      },
      storedFields,
      clock,
    );
    expect(mixed.stored).toBeNull();
    expect(
      rows.filter((item) => mixed.memory?.(item)).map((r) => r.id),
    ).toEqual(['priced', 'dollars']);
    expect(() =>
      planListWhere(
        {
          match: 'any',
          conditions: [
            { field: 'owner', op: 'any_of', value: [owner] },
            { field: 'count', op: 'gt', value: 1 },
          ],
        },
        storedFields,
        clock,
      ),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message:
          'Condition 1: This field cannot be combined with these conditions.',
      }),
    );
  });

  it('rejects unknown fields, operators and malformed values with the condition number', () => {
    const rejected = (condition: ListCondition, message: string) =>
      expect(() =>
        planListWhere(
          {
            match: 'all',
            conditions: [{ field: 'count', op: 'empty' }, condition],
          },
          storedFields,
          clock,
        ),
      ).toThrow(
        expect.objectContaining({
          statusCode: 400,
          message: `Condition 2: ${message}`,
        }),
      );
    rejected(
      { field: 'missing', op: 'empty' },
      'This field cannot be filtered.',
    );
    rejected(
      { field: 'count', op: 'contains', value: 'a' },
      'This field does not support this operator.',
    );
    rejected(
      { field: 'owner', op: 'any_of', value: ['not-an-id'] },
      'This value is not a valid record ID.',
    );
    rejected(
      { field: 'at', op: 'before', value: 'yesterday' },
      'Dates need a day (YYYY-MM-DD), a time with an offset or today.',
    );
    rejected(
      { field: 'total', op: 'eq', value: 5 },
      'Amounts need a currency.',
    );
  });
});
