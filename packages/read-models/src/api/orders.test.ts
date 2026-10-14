import {
  collectionField,
  orderListQuerySchema,
  ordersCatalog,
  orderSortSchema,
} from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  orderComparisonStates,
  orderFulfillmentStates,
  orderPaymentStatuses,
  orderStatuses,
} from '../application/orders.js';
import { validateOrderListQuery } from './orders.js';

const parse = (query: Record<string, string>) =>
  orderListQuerySchema.parse(query);

describe('Orders list query', () => {
  it('orders options and sorts as the Orders catalog lists them', () => {
    expect(collectionField(ordersCatalog, 'status')?.options).toEqual(
      orderStatuses,
    );
    expect(collectionField(ordersCatalog, 'paymentStatus')?.options).toEqual(
      orderPaymentStatuses,
    );
    expect(collectionField(ordersCatalog, 'fulfillment')?.options).toEqual(
      orderFulfillmentStates,
    );
    expect(collectionField(ordersCatalog, 'comparison')?.options).toEqual(
      orderComparisonStates,
    );
    expect(
      ordersCatalog.fields
        .filter((field) => field.sort)
        .map((field) => field.id),
    ).toEqual(expect.arrayContaining([...orderSortSchema.options]));
    expect(orderSortSchema.options).toEqual(
      expect.arrayContaining(
        ordersCatalog.fields
          .filter((field) => field.sort)
          .map((field) => field.id),
      ),
    );
  });

  it('parses conditions, groups, group keys and time zones', () => {
    const query = parse({
      where: JSON.stringify({
        conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
      }),
      group: 'placed:week',
      groupKey: '"2026-10-12"',
      timeZone: 'Europe/Berlin',
    });

    expect(query).toMatchObject({
      where: {
        match: 'all',
        conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
      },
      group: { field: 'placed', granularity: 'week' },
      groupKey: '2026-10-12',
      groupLimit: 10,
      timeZone: 'Europe/Berlin',
    });
    expect(parse({ group: 'status', groupKey: 'null' })).toMatchObject({
      group: { field: 'status', granularity: undefined },
      groupKey: null,
    });
    expect(() => parse({ timeZone: 'Mars/Olympus' })).toThrow();
    expect(() => parse({ where: '{' })).toThrow();
  });

  it('rejects conditions and groups the catalog does not support with a readable 400', () => {
    const invalid = (query: Record<string, string>) => {
      try {
        validateOrderListQuery(parse(query));
      } catch (error) {
        return error;
      }

      return null;
    };

    expect(
      invalid({
        where: JSON.stringify({
          conditions: [
            { field: 'status', op: 'any_of', value: ['open'] },
            { field: 'total', op: 'gt', value: 10 },
          ],
        }),
      }),
    ).toMatchObject({
      statusCode: 400,
      expose: true,
      message: 'Condition 2: Amounts need a currency.',
    });
    expect(
      invalid({
        where: JSON.stringify({
          conditions: [{ field: 'number', op: 'contains', value: '1' }],
        }),
      }),
    ).toMatchObject({ message: 'Condition 1: This field cannot be filtered.' });
    expect(invalid({ group: 'placed' })).toMatchObject({
      message: 'Date groups need a day, week or month.',
    });
    expect(invalid({ group: 'total' })).toMatchObject({
      message: 'This field cannot be grouped.',
    });
    expect(invalid({ groupKey: '"open"' })).toMatchObject({ statusCode: 400 });
    // Permission-gated fields pass here; the workspace answers 403 for readers without access.
    expect(
      invalid({
        where: JSON.stringify({
          conditions: [
            {
              field: 'warehouse',
              op: 'any_of',
              value: ['3f1c1d1e-0000-4000-8000-000000000001'],
            },
          ],
        }),
        group: 'status',
      }),
    ).toBeNull();
  });
});
