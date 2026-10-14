import { describe, expect, it } from 'vitest';

import {
  compareDecimals,
  formatDecimal,
  orderValue,
  parseDecimal,
} from './order-value.js';
import type { PurchaseOrderLine } from './procurement.js';

const line = (
  quantity: number,
  unitPrice?: PurchaseOrderLine['unitPrice'],
): PurchaseOrderLine => ({
  id: `${quantity}`,
  sku: 'TOTE',
  description: 'Tote',
  quantity,
  unit: 'each',
  ...(unitPrice ? { unitPrice } : {}),
});

describe('purchase order value', () => {
  it('sums quantity times unit price exactly', () => {
    expect(
      orderValue({
        lines: [
          line(3, { amount: '0.10', currency: 'EUR' }),
          line(2.5, { amount: '19.99999999', currency: 'EUR' }),
        ],
      }),
    ).toEqual({ amount: '50.299999975', currency: 'EUR' });
  });

  it('is empty without prices and unknown when prices are partial or mixed', () => {
    expect(orderValue({ lines: [line(1), line(2)] })).toBeNull();
    expect(
      orderValue({
        lines: [line(1, { amount: '2', currency: 'EUR' }), line(2)],
      }),
    ).toBe('unknown');
    expect(
      orderValue({
        lines: [
          line(1, { amount: '2', currency: 'EUR' }),
          line(2, { amount: '2', currency: 'USD' }),
        ],
      }),
    ).toBe('unknown');
  });

  it('parses exponent notation and compares numerically', () => {
    expect(formatDecimal(parseDecimal(String(1e-7))!)).toBe('0.0000001');
    expect(formatDecimal(parseDecimal('-12.500')!)).toBe('-12.5');
    expect(compareDecimals(parseDecimal('9')!, parseDecimal('10.0')!)).toBe(-1);
    expect(parseDecimal('1,5')).toBeNull();
  });
});
