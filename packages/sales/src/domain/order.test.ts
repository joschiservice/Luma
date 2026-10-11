import { describe, expect, it } from 'vitest';

import { decimal, units } from './order.js';

describe('sales decimal arithmetic', () => {
  it('preserves large fractional quantities and zero without floating-point rounding', () => {
    for (const value of [
      '0',
      '1',
      '0.000001',
      '99999999999999.999999',
      '10000000000000.000001',
    ])
      expect(decimal(units(value))).toBe(value);
    expect(decimal(units('2') - units('1.999999'))).toBe('0.000001');
  });
});
