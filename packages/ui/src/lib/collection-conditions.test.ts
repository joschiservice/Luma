import type { CollectionWhere } from '@luma/api-contract';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type Condition,
  conditionComplete,
  conditionDefaultValue,
  type ConditionField,
  conditionValueKind,
  conditionValueLabel,
  type ConditionWhere,
  describeCondition,
  finishCondition,
  whereWithCellValue,
} from './collection-conditions';

const status: ConditionField = {
  id: 'status',
  label: 'Status',
  type: 'enum',
  operators: ['any_of', 'none_of', 'empty', 'not_empty'],
  options: [
    { value: 'open', label: 'Open' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'unknown', label: 'Unknown' },
  ],
};
const total: ConditionField = {
  id: 'total',
  label: 'Total',
  type: 'money',
  operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty'],
  currencies: ['EUR', 'USD'],
};
const placed: ConditionField = {
  id: 'placed',
  label: 'Placed',
  type: 'date',
  operators: ['before', 'after', 'between', 'within_last', 'within_next'],
};
const number: ConditionField = {
  id: 'number',
  label: 'Order',
  type: 'text',
  operators: ['contains', 'is', 'is_not'],
};
const where = (conditions: Condition[] = []): ConditionWhere => ({
  match: 'all',
  conditions,
});

describe('condition shapes', () => {
  it('match the list API contract in both directions', () => {
    expectTypeOf<CollectionWhere>().toExtend<ConditionWhere>();
    expectTypeOf<ConditionWhere>().toExtend<CollectionWhere>();
  });
});

describe('conditionValueKind', () => {
  it('chooses an editor from the field type and operator', () => {
    expect(conditionValueKind(status, 'any_of')).toBe('options');
    expect(conditionValueKind(status, 'empty')).toBe('none');
    expect(conditionValueKind(total, 'gt')).toBe('money');
    expect(conditionValueKind(total, 'between')).toBe('money-range');
    expect(conditionValueKind(placed, 'before')).toBe('date');
    expect(conditionValueKind(placed, 'between')).toBe('date-range');
    expect(conditionValueKind(placed, 'within_last')).toBe('relative');
    expect(conditionValueKind(number, 'contains')).toBe('text');
    expect(
      conditionValueKind({ type: 'boolean', options: undefined }, 'is'),
    ).toBe('boolean');
  });
});

describe('conditionComplete', () => {
  it('needs a value of the right shape', () => {
    expect(
      conditionComplete(status, { field: 'status', op: 'any_of', value: [] }),
    ).toBe(false);
    expect(
      conditionComplete(status, {
        field: 'status',
        op: 'any_of',
        value: ['open'],
      }),
    ).toBe(true);
    expect(conditionComplete(status, { field: 'status', op: 'empty' })).toBe(
      true,
    );
    expect(
      conditionComplete(total, {
        field: 'total',
        op: 'gt',
        value: { amount: '12,5', currency: 'EUR' },
      }),
    ).toBe(false);
    expect(
      conditionComplete(total, {
        field: 'total',
        op: 'gt',
        value: { amount: '12.5', currency: 'EUR' },
      }),
    ).toBe(true);
    expect(
      conditionComplete(placed, {
        field: 'placed',
        op: 'before',
        value: { dynamic: 'today' },
      }),
    ).toBe(true);
    expect(
      conditionComplete(placed, {
        field: 'placed',
        op: 'between',
        value: { from: null, to: null },
      }),
    ).toBe(false);
  });
});

describe('conditionDefaultValue', () => {
  it('keeps a value that fits the new operator and resets one that does not', () => {
    const previous: Condition = {
      field: 'status',
      op: 'any_of',
      value: ['open'],
    };
    expect(conditionDefaultValue(status, 'none_of', previous)).toEqual([
      'open',
    ]);
    expect(conditionDefaultValue(status, 'empty', previous)).toBeUndefined();
    expect(conditionDefaultValue(total, 'between')).toEqual({
      from: { amount: '', currency: 'EUR' },
      to: { amount: '', currency: 'EUR' },
    });
  });
});

describe('finishCondition', () => {
  it('drops blank range bounds and values operators do not take', () => {
    expect(
      finishCondition(total, {
        field: 'total',
        op: 'between',
        value: {
          from: { amount: '10', currency: 'EUR' },
          to: { amount: '', currency: 'EUR' },
        },
      }),
    ).toEqual({
      field: 'total',
      op: 'between',
      value: { from: { amount: '10', currency: 'EUR' }, to: null },
    });
    expect(
      finishCondition(status, { field: 'status', op: 'empty', value: [] }),
    ).toEqual({ field: 'status', op: 'empty' });
  });

  it('keeps a source scope only for per-source fields', () => {
    expect(
      finishCondition(number, {
        field: 'number',
        op: 'contains',
        value: ' 10 ',
        source: 'any',
      }),
    ).toEqual({ field: 'number', op: 'contains', value: '10' });
  });
});

describe('describeCondition', () => {
  it('names the field, operator and values', () => {
    expect(
      describeCondition(status, {
        field: 'status',
        op: 'any_of',
        value: ['open', 'completed'],
      }),
    ).toBe('Status is any of Open or Completed');
    expect(
      describeCondition(status, {
        field: 'status',
        op: 'any_of',
        value: ['open', 'completed', 'cancelled', 'unknown'],
      }),
    ).toBe('Status is any of Open, Completed and 2 more');
    expect(
      describeCondition(placed, {
        field: 'placed',
        op: 'within_last',
        value: { amount: 7, unit: 'day' },
      }),
    ).toBe('Placed is in the last 7 days');
    expect(describeCondition(status, { field: 'status', op: 'empty' })).toBe(
      'Status is empty',
    );
    expect(
      describeCondition(number, {
        field: 'number',
        op: 'contains',
        value: '10',
      }),
    ).toBe('Order contains “10”');
  });
});

describe('whereWithCellValue', () => {
  it('filters to a choice value and merges exclusions', () => {
    const included = whereWithCellValue(where(), status, 'open');
    expect(included?.conditions).toEqual([
      { field: 'status', op: 'any_of', value: ['open'] },
    ]);
    const excluded = whereWithCellValue(
      whereWithCellValue(where(), status, 'open', true)!,
      status,
      'completed',
      true,
    );
    expect(excluded?.conditions).toEqual([
      { field: 'status', op: 'none_of', value: ['open', 'completed'] },
    ]);
  });

  it('replaces an earlier inclusion on the same field', () => {
    const first = whereWithCellValue(where(), status, 'open')!;
    expect(whereWithCellValue(first, status, 'completed')?.conditions).toEqual([
      { field: 'status', op: 'any_of', value: ['completed'] },
    ]);
  });

  it('matches missing values with empty and refuses unsupported operators', () => {
    expect(whereWithCellValue(where(), status, null)?.conditions).toEqual([
      { field: 'status', op: 'empty' },
    ]);
    expect(whereWithCellValue(where(), placed, '2026-10-01', true)).toBe(
      undefined,
    );
    expect(
      whereWithCellValue(where(), number, 'SO-10', true)?.conditions,
    ).toEqual([{ field: 'number', op: 'is_not', value: 'SO-10' }]);
  });
});

describe('resolved condition labels', () => {
  const person = {
    id: 'owner',
    label: 'Owner',
    type: 'person' as const,
    operators: ['any_of' as const],
  };
  const placed = {
    id: 'placed',
    label: 'Placed',
    type: 'date' as const,
    operators: ['within_last' as const],
  };

  it('names the reader behind “me” and the days a relative period covers', () => {
    expect(
      conditionValueLabel(
        person,
        { field: 'owner', op: 'any_of', value: [{ dynamic: 'me' }] },
        { me: 'Anna' },
      ),
    ).toContain('Anna');
    const period = conditionValueLabel(
      placed,
      { field: 'placed', op: 'within_last', value: { amount: 7, unit: 'day' } },
      { today: '2026-10-13' },
    );
    expect(period).toMatch(/6/);
    expect(period).toMatch(/13/);
    expect(
      conditionValueLabel(placed, {
        field: 'placed',
        op: 'within_last',
        value: { amount: 7, unit: 'day' },
      }),
    ).not.toMatch(/13/);
  });
});
