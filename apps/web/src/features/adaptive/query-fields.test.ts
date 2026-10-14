import { adaptiveViewDomainSchema, type CustomField } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { emptyViewQuery } from './data';
import {
  columnFields,
  conditionFields,
  editableCondition,
  groupFields,
  invalidConditions,
  newCondition,
  parseValue,
  sortFields,
  viewColumns,
} from './query-fields';

const note: CustomField = {
  id: '11111111-1111-4111-8111-111111111111',
  recordType: 'order',
  key: 'buyer_note',
  label: { en: 'Buyer note', de: 'Einkaufsnotiz' },
  type: 'single_choice',
  choices: [{ key: 'rush', label: { en: 'Rush', de: 'Eilig' } }],
  readPermission: 'adaptive.fields.read',
  writePermission: 'adaptive.fields.write',
  revision: 1,
  archived: false,
  source: 'luma',
  createdAt: '2026-10-13T09:00:00.000Z',
  updatedAt: '2026-10-13T09:00:00.000Z',
};

describe('view editor fields', () => {
  it('starts every previewable list with columns from its catalog', () => {
    for (const domain of adaptiveViewDomainSchema.options) {
      const query = emptyViewQuery(domain);
      expect(query.version).toBe(2);
      for (const column of viewColumns(query))
        expect(columnFields(domain)).toContain(column);
    }
  });

  it('offers catalog filters, owner filters and readable custom fields', () => {
    const orders = conditionFields('orders', [note]);
    expect(orders.find((field) => field.id === 'status')?.operators).toContain(
      'any_of',
    );
    expect(orders.find((field) => field.id === 'number')).toBeUndefined();
    expect(
      orders.find((field) => field.id === `custom:${note.id}`),
    ).toMatchObject({ type: 'enum', options: ['rush'] });
    // Issues filter owners natively, including several people and nobody.
    expect(
      conditionFields('issues').find((field) => field.id === 'owner'),
    ).toMatchObject({ operators: ['any_of', 'none_of', 'empty', 'not_empty'] });
    expect(
      conditionFields('issues').find((field) => field.id === 'owner'),
    ).not.toHaveProperty('ownerFilter');
    // Once the list API filters a field, the catalog filter replaces the owner filter.
    expect(
      conditionFields('procurement').find((field) => field.id === 'attention'),
    ).not.toHaveProperty('ownerFilter');
    expect(conditionFields('inventory', [note])).not.toContainEqual(
      expect.objectContaining({ id: `custom:${note.id}` }),
    );
  });

  it('sorts by catalog sorts and groups dates by period', () => {
    expect(sortFields('orders')).toContain('updated');
    expect(sortFields('orders')).not.toContain('sources');
    expect(groupFields('orders')).toContainEqual({
      id: 'placed',
      granularities: ['day', 'week', 'month'],
    });
    expect(groupFields('orders')).toContainEqual({
      id: 'updated',
      granularities: undefined,
    });
  });

  it('reports conditions the view could not run', () => {
    // Issues run owner conditions natively; their summary can't be filtered.
    expect(
      invalidConditions(conditionFields('issues'), [
        { field: 'owner', op: 'any_of', value: ['member-1'] },
        { field: 'owner', op: 'any_of', value: ['member-1', 'member-2'] },
        { field: 'summary', op: 'any_of', value: ['Late'] },
      ]),
    ).toEqual([2]);
    expect(
      invalidConditions(conditionFields('procurement'), [
        {
          field: 'attention',
          op: 'any_of',
          value: ['delivery_overdue', 'confirmation_overdue'],
        },
        { field: 'attention', op: 'any_of', value: ['nope'] },
        { field: 'reference', op: 'any_of', value: ['PO-1'] },
      ]),
    ).toEqual([1, 2]);
    const orders = conditionFields('orders');
    expect(
      invalidConditions(orders, [
        { field: 'status', op: 'any_of', value: ['open'] },
        { field: 'status', op: 'any_of', value: ['nope'] },
        { field: 'lineCount', op: 'gt', value: '3' },
        { field: 'overdue', op: 'empty' },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it('keeps complex conditions out of the simple editor', () => {
    const placed = conditionFields('orders').find(
      (field) => field.id === 'placed',
    );
    expect(
      editableCondition(placed, {
        field: 'placed',
        op: 'within_last',
        value: { amount: 7, unit: 'day' },
      }),
    ).toBe(false);
    expect(
      editableCondition(placed, {
        field: 'placed',
        op: 'after',
        value: '2026-10-01',
      }),
    ).toBe(true);
    expect(placed && newCondition(placed).op).toBe('before');
  });

  it('reads comma-separated list values and typed numbers', () => {
    expect(parseValue({ type: 'text' }, 'any_of', 'a, b,,')).toEqual([
      'a',
      'b',
    ]);
    expect(parseValue({ type: 'number' }, 'gt', '4')).toBe(4);
    expect(parseValue({ type: 'number' }, 'gt', '')).toBeUndefined();
  });
});
