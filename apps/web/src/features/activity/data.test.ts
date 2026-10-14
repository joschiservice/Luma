import { describe, expect, it } from 'vitest';

import {
  activityConditions,
  activityFiltersOf,
  activityRange,
  parseActivityFilters,
  withoutLegacyActivityFilters,
} from './data';

const person = '33333333-3333-4333-8333-333333333333';

describe('activity URL state', () => {
  it('preserves supported filters and position', () => {
    const value = {
      from: '2026-09-01',
      to: '2026-09-22',
      q: 'Order 1042',
      type: 'verification',
      outcome: 'uncertain',
      system: 'jtl-cloud',
      cursor: 'abc',
      event: 'event',
    };
    expect(parseActivityFilters(value)).toMatchObject(value);
  });
  it('discards invalid dates, overlong ranges and unsupported filters', () => {
    expect(
      parseActivityFilters({
        from: '2026-02-30',
        type: 'payload',
        outcome: 'success',
        connectionId: 'secret',
      }),
    ).toMatchObject({
      from: undefined,
      type: undefined,
      outcome: undefined,
      connectionId: undefined,
    });
    expect(
      parseActivityFilters({ from: '2020-01-01', to: '2026-09-22' }).from,
    ).toBeUndefined();
    expect(parseActivityFilters({ q: 'x'.repeat(201) }).q).toHaveLength(200);
  });
  it('resolves default dates in UTC', () => {
    expect(activityRange({}, new Date('2026-09-22T00:00:00Z'))).toEqual({
      from: '2026-08-24',
      to: '2026-09-22',
    });
  });
  it('keeps relative periods relative to today', () => {
    expect(
      activityRange(
        { last: { amount: 6, unit: 'day' } },
        new Date('2026-09-22T12:00:00Z'),
      ),
    ).toEqual({ from: '2026-09-16', to: '2026-09-22' });
    expect(
      activityRange(
        { last: { amount: 1, unit: 'month' } },
        new Date('2026-09-22T12:00:00Z'),
      ),
    ).toEqual({ from: '2026-08-22', to: '2026-09-22' });
  });
});

describe('activity view conditions', () => {
  it('round-trips filters through the view conditions', () => {
    const filters = {
      last: { amount: 6, unit: 'day' as const },
      system: 'jtl-cloud',
      type: 'procurement' as const,
      outcome: 'verified' as const,
      actor: ['me', 'luma', person],
    };
    const where = {
      match: 'all' as const,
      conditions: activityConditions(filters),
    };
    expect(where.conditions).toContainEqual({
      field: 'actor',
      op: 'any_of',
      value: [{ dynamic: 'me' }, 'luma', person],
    });
    expect(activityFiltersOf(where, '2026-09-22')).toEqual({
      filters,
      issues: [],
    });
  });

  it('marks conditions the activity API cannot apply', () => {
    const { filters, issues } = activityFiltersOf(
      {
        match: 'all',
        conditions: [
          { field: 'type', op: 'any_of', value: ['issue', 'decision'] },
          { field: 'outcome', op: 'any_of', value: ['verified'] },
          { field: 'outcome', op: 'any_of', value: ['failed'] },
          { field: 'action', op: 'contains', value: 'approve' },
          {
            field: 'time',
            op: 'within_last',
            value: { amount: 2, unit: 'month' },
          },
          { field: 'actor', op: 'any_of', value: ['someone'] },
        ],
      },
      '2026-09-22',
    );
    expect(issues.map((issue) => issue.index).sort()).toEqual([0, 2, 3, 5]);
    expect(filters).toEqual({
      outcome: 'verified',
      last: { amount: 2, unit: 'month' },
    });
    expect(
      activityFiltersOf(
        {
          match: 'all',
          conditions: [
            {
              field: 'time',
              op: 'within_last',
              value: { amount: 13, unit: 'month' },
            },
          ],
        },
        '2026-09-22',
      ).issues,
    ).toHaveLength(1);
    expect(
      activityFiltersOf({
        match: 'any',
        conditions: [
          { field: 'type', op: 'any_of', value: ['issue'] },
          { field: 'outcome', op: 'any_of', value: ['verified'] },
        ],
      }).issues,
    ).toContainEqual(expect.objectContaining({ index: null }));
  });

  it('turns filters of older links into conditions', () => {
    expect(
      withoutLegacyActivityFilters({
        type: 'procurement',
        from: '2026-09-01',
        to: '2026-09-22',
        q: 'run-1',
        cursor: 'stale',
      }),
    ).toEqual({
      q: 'run-1',
      where: {
        match: 'all',
        conditions: [
          {
            field: 'time',
            op: 'between',
            value: { from: '2026-09-01', to: '2026-09-22' },
          },
          { field: 'type', op: 'any_of', value: ['procurement'] },
        ],
      },
    });
  });
});
