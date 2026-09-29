import { describe, expect, it } from 'vitest';

import type { StockSource } from './inventory.js';
import { stockDecimal, stockDifferences } from './inventory.js';

const source = (overrides: Partial<StockSource>): StockSource => ({
  connectionId: 'source',
  label: 'Source',
  status: 'active',
  externalSku: null,
  externalLocation: null,
  mappingMethod: null,
  onHand: null,
  reserved: null,
  available: null,
  incoming: null,
  availabilityBasis: 'unknown',
  observedAt: '2026-09-29T00:00:00Z',
  sourceUpdatedAt: null,
  deleted: false,
  ...overrides,
});
describe('stock comparison', () => {
  it('preserves six-decimal precision for large and negative values', () => {
    expect(
      stockDecimal('99999999999999.999999') -
        stockDecimal('99999999999999.999998'),
    ).toBe(1n);
    expect(stockDecimal('-0.000001')).toBe(-1n);
  });
  it('compares known values only and ignores removed snapshots', () => {
    expect(
      stockDifferences([
        source({ available: '0' }),
        source({ available: null }),
        source({ available: '8', deleted: true }),
      ]),
    ).toEqual([]);
    expect(
      stockDifferences([
        source({ available: '1.0' }),
        source({ available: '1.000000' }),
      ]),
    ).toEqual([]);
    expect(
      stockDifferences([
        source({ available: '1', reserved: '0' }),
        source({ available: '2', reserved: '1' }),
      ]),
    ).toEqual(['reserved', 'available']);
  });
});
