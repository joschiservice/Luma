import { describe, expect, it } from 'vitest';

import { lineValue } from './line-value.js';

const eur = (amount: string) => ({ amount, currency: 'EUR' });

describe('lineValue', () => {
  it('multiplies decimal prices exactly', () => {
    // 0.1 × 3 is 0.30000000000000004 in floating point.
    expect(lineValue(eur('0.1'), '3')).toEqual(eur('0.3'));
    expect(lineValue(eur('19.99'), '3')).toEqual(eur('59.97'));
    expect(lineValue(eur('12345678901234.99'), '2')).toEqual(
      eur('24691357802469.98'),
    );
  });

  it('keeps fractional units and rounds to millionths', () => {
    expect(lineValue(eur('4.5'), '1.25')).toEqual(eur('5.625'));
    expect(lineValue(eur('0.000001'), '0.5')).toEqual(eur('0.000001'));
    expect(lineValue(eur('-0.000001'), '0.5')).toEqual(eur('-0.000001'));
  });

  it('is zero for zero units and unknown when a fact is missing', () => {
    expect(lineValue(eur('19.99'), '0')).toEqual(eur('0'));
    expect(lineValue(eur('19.99'), null)).toBeNull();
    expect(lineValue(null, '2')).toBeNull();
    expect(lineValue(undefined, '2')).toBeNull();
  });
});
