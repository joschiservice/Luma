import { describe, expect, it } from 'vitest';

import {
  fulfillmentState,
  lineProgress,
  orderDifferences,
  orderOpen,
  orderOverdue,
  sumQuantities,
} from './orders.js';

const line = (
  quantity: string,
  cancelledQuantity: string | null = '0',
  skuId: string | null = 'sku-a',
) => ({ id: `line-${quantity}`, skuId, quantity, cancelledQuantity });

describe('order progress', () => {
  it('adds decimal quantities without floating-point rounding', () => {
    expect(sumQuantities(['0.1', '0.2'])).toBe('0.3');
    expect(sumQuantities(['1.000000', '2.5'])).toBe('3.5');
    expect(sumQuantities([])).toBe('0');
  });

  it('keeps remaining work unknown when the source does not report cancellations', () => {
    expect(lineProgress(line('3', null), '1')).toEqual({
      fulfilledQuantity: '1',
      remainingQuantity: null,
    });
    expect(lineProgress(line('3', null), '3')).toEqual({
      fulfilledQuantity: '3',
      remainingQuantity: '0',
    });
    expect(lineProgress(line('3', '1'), '0.5')).toEqual({
      fulfilledQuantity: '0.5',
      remainingQuantity: '1.5',
    });
  });

  it('distinguishes fulfilled, partial, unfulfilled and cancelled work', () => {
    const done = { fulfilledQuantity: '2', remainingQuantity: '0' };
    const waiting = { fulfilledQuantity: '0', remainingQuantity: '2' };
    const unknown = { fulfilledQuantity: '1', remainingQuantity: null };
    const cancelled = { fulfilledQuantity: '0', remainingQuantity: '0' };
    expect(fulfillmentState([done])).toBe('fulfilled');
    expect(fulfillmentState([done, waiting])).toBe('partial');
    expect(fulfillmentState([unknown])).toBe('partial');
    expect(fulfillmentState([waiting])).toBe('unfulfilled');
    expect(fulfillmentState([cancelled])).toBe('not_required');
    expect(fulfillmentState([])).toBe('no_lines');
  });

  it('classifies open and overdue orders like the order metrics', () => {
    const waiting = [{ fulfilledQuantity: '0', remainingQuantity: '2' }];
    const unknown = [{ fulfilledQuantity: '0', remainingQuantity: null }];
    expect(orderOpen({ status: 'open', deleted: false }, waiting)).toBe(true);
    expect(orderOpen({ status: 'open', deleted: false }, unknown)).toBeNull();
    expect(orderOpen({ status: 'open', deleted: true }, waiting)).toBe(false);
    expect(orderOpen({ status: 'completed', deleted: false }, waiting)).toBe(
      false,
    );
    expect(
      orderOpen({ status: 'unknown', deleted: false }, waiting),
    ).toBeNull();
    expect(orderOpen({ status: 'open', deleted: false }, [])).toBeNull();

    const asOf = '2026-09-29T00:00:00.000Z';
    expect(orderOverdue(true, '2026-09-28T00:00:00.000Z', asOf)).toBe(true);
    expect(orderOverdue(true, '2026-09-30T00:00:00.000Z', asOf)).toBe(false);
    expect(orderOverdue(true, null, asOf)).toBeNull();
    expect(orderOverdue(null, '2026-09-28T00:00:00.000Z', asOf)).toBeNull();
    expect(orderOverdue(false, '2026-09-28T00:00:00.000Z', asOf)).toBe(false);
  });
});

describe('order differences', () => {
  const source = (
    connectionId: string,
    overrides: Partial<Parameters<typeof orderDifferences>[0][number]> = {},
  ) => ({
    connectionId,
    deleted: false,
    status: 'open',
    paymentStatus: 'paid',
    total: { amount: '42.50', currency: 'EUR' },
    lines: [line('2')],
    ...overrides,
  });

  it('reports only known values that disagree between current sources', () => {
    expect(
      orderDifferences([
        source('a'),
        source('b', { total: { amount: '42.5', currency: 'EUR' } }),
      ]),
    ).toEqual([]);
    expect(
      orderDifferences([
        source('a'),
        source('b', { paymentStatus: 'unknown', total: null }),
      ]),
    ).toEqual([]);
    expect(
      orderDifferences([
        source('a'),
        source('b', { status: 'completed', lines: [line('3')] }),
      ]).map((difference) => difference.field),
    ).toEqual(['status', 'lines']);
  });

  it('compares ordered quantity per SKU and ignores removed or single sources', () => {
    expect(
      orderDifferences([
        source('a', { lines: [line('1'), line('1.5')] }),
        source('b', { lines: [line('2.5')] }),
      ]),
    ).toEqual([]);
    expect(
      orderDifferences([source('a'), source('b', { status: 'cancelled' })]),
    ).toHaveLength(1);
    expect(
      orderDifferences([
        source('a'),
        source('b', { status: 'cancelled', deleted: true }),
      ]),
    ).toEqual([]);
  });
});
