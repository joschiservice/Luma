import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { describe, expect, it } from 'vitest';

import {
  customFieldIds,
  customListFields,
  customSortField,
  readableCustomFields,
  withCustomReader,
} from './custom-fields.js';
import { planListWhere } from './list-conditions.js';
import type { ListCustomField } from './lists.js';

const number = '6d5f0c1a-2b3c-4d5e-8f90-1a2b3c4d5e6f';
const due = '7e6a1d2b-3c4d-4e5f-9a01-2b3c4d5e6f70';
const labels = '8f7b2e3c-4d5e-4f60-8b12-3c4d5e6f7081';
const buyer = '9a8c3f4d-5e6f-4071-9c23-4d5e6f708192';
const approved = 'ab9d4a5e-6f70-4182-8d34-5e6f708192a3';
const fields: ListCustomField[] = [
  { id: number, type: 'number' },
  { id: due, type: 'date' },
  { id: labels, type: 'multi_choice' },
  { id: buyer, type: 'person' },
  { id: approved, type: 'boolean' },
];
const clock = { now: new Date('2026-10-13T08:00:00Z'), timeZone: 'UTC' };

function reader(permissions: string[]) {
  const tenant = '0b7a2c1e-0000-4000-8000-000000000001';

  return makeTenantContext(
    { userId: 'reader', sessionId: 'session' },
    {
      id: tenant,
      name: 'Fixture',
      slug: 'fixture',
      status: 'active',
      dataRegion: 'EU',
    },
    {
      ...builtInMembership(
        { id: 'membership', organizationId: tenant, userId: 'reader' },
        'owner',
      ),
      permissions: new PermissionSet(permissions),
    },
    'request',
  );
}

describe('custom fields on procurement lists', () => {
  it('names each custom field of the conditions and sort once', () => {
    expect(
      customFieldIds(
        {
          match: 'all',
          conditions: [
            { field: `custom:${number}`, op: 'empty' },
            { field: 'status', op: 'empty' },
            { field: `custom:${number}`, op: 'not_empty' },
          ],
        },
        `custom:${due}`,
      ),
    ).toEqual([number, due]);
    expect(customFieldIds(undefined, 'created')).toEqual([]);
  });

  it('refuses unavailable fields with 400 and unreadable fields with 403', () => {
    const context = reader(['procurement.read']);
    expect(
      readableCustomFields(
        context,
        [number],
        [{ id: number, type: 'number', readPermission: 'procurement.read' }],
      ),
    ).toEqual([{ id: number, type: 'number' }]);
    expect(() => readableCustomFields(context, [number], [])).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'A custom field is unavailable.',
      }),
    );
    for (const readPermission of ['orders.read', null])
      expect(() =>
        readableCustomFields(
          context,
          [number],
          [{ id: number, type: 'number', readPermission }],
        ),
      ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('sends every custom condition to SQL with its resolved values', () => {
    const where = withCustomReader(
      {
        match: 'all',
        conditions: [
          {
            field: `custom:${number}`,
            op: 'between',
            value: { from: 2, to: null },
          },
          { field: `custom:${number}`, op: 'ne', value: 5 },
          { field: `custom:${due}`, op: 'after', value: '2026-10-01' },
          {
            field: `custom:${due}`,
            op: 'within_next',
            value: { amount: 1, unit: 'week' },
          },
          { field: `custom:${labels}`, op: 'all_of', value: ['eu', 'urgent'] },
          {
            field: `custom:${buyer}`,
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          },
          { field: `custom:${approved}`, op: 'is', value: false },
        ],
      },
      'reader',
    );
    const plan = planListWhere(where, customListFields(fields), clock);
    expect(plan.memory).toBeNull();
    expect(plan.stored?.conditions).toEqual([
      {
        field: `custom:${number}`,
        op: 'compare',
        comparisons: [{ op: 'gte', value: '2' }],
      },
      {
        field: `custom:${number}`,
        op: 'compare',
        comparisons: [{ op: 'ne', value: '5' }],
      },
      // Dates are calendar days and compare as days.
      {
        field: `custom:${due}`,
        op: 'range',
        from: { at: '2026-10-01', inclusive: false },
        to: null,
      },
      {
        field: `custom:${due}`,
        op: 'range',
        from: { at: '2026-10-13', inclusive: true },
        to: { at: '2026-10-20', inclusive: true },
      },
      {
        field: `custom:${labels}`,
        op: 'all_of',
        values: ['eu', 'urgent'],
      },
      { field: `custom:${buyer}`, op: 'any_of', values: ['reader'] },
      { field: `custom:${approved}`, op: 'flag', value: false },
    ]);
  });

  it('accepts only the operators of the field type', () => {
    expect(() =>
      planListWhere(
        {
          match: 'all',
          conditions: [
            { field: `custom:${number}`, op: 'contains', value: '1' },
          ],
        },
        customListFields(fields),
        clock,
      ),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: 'Condition 1: This field does not support this operator.',
      }),
    );
  });

  it('orders only by custom fields with one value', () => {
    expect(customSortField(fields, 'created')).toBeNull();
    expect(customSortField(fields, `custom:${number}`)).toEqual(fields[0]);
    expect(() => customSortField(fields, `custom:${labels}`)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});
