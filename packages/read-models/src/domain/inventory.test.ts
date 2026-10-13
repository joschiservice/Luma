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
  it('compares reservation quantities only when their meanings agree', () => {
    expect(
      stockDifferences([
        source({
          reserved: '1',
          inventorySemantics: 'shopify/1',
          available: '-2',
        }),
        source({ reserved: '5', available: '3' }),
      ]),
    ).toEqual(['available']);
    expect(
      stockDifferences([
        source({ reserved: '1', inventorySemantics: 'shopify/1' }),
        source({ reserved: '2', inventorySemantics: 'shopify/1' }),
      ]),
    ).toEqual(['reserved']);
  });
  it('keeps differences within comparable sources when another meaning is present', () => {
    expect(
      stockDifferences([
        source({ reserved: '1', inventorySemantics: 'shopify/1' }),
        source({ reserved: '5' }),
        source({ reserved: '7' }),
      ]),
    ).toEqual(['reserved']);
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
