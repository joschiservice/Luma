import { describe, expect, it } from 'vitest';

import {
  purchasingAmountUnits,
  type PurchasingStock,
  recommendPurchase,
} from './purchasing.js';

const now = Date.parse('2026-10-13T08:00:00Z');
const stock: PurchasingStock = {
  positionId: 'position',
  skuId: 'sku',
  sku: 'SKU',
  locationId: 'location',
  location: 'Tokyo',
  connectionId: 'source',
  unit: 'each',
  available: 10,
  reserved: 5,
  observedAt: new Date(now - 1000).toISOString(),
  observationId: 'observation',
  complete: true,
  authoritative: true,
};
const input = {
  stocks: [stock],
  demand: {
    daily: 2,
    units: 60,
    periodDays: 30,
    observedAt: stock.observedAt,
    evidenceRefs: ['orders'],
    complete: true,
  },
  leadTimeDays: 7,
  packSize: 6,
  minimumQuantity: 12,
  safetyDays: 3,
  committed: false,
  rule: null,
  now,
};

describe('explainable purchasing', () => {
  it('shows raw need, pack rounding, cover and order deadline', () => {
    expect(recommendPurchase(input)).toEqual({
      available: 10,
      daysOfCover: 5,
      rawQuantity: 10,
      quantity: 12,
      orderBy: new Date(now - 5 * 86_400_000).toISOString(),
      missing: [],
    });
  });
  it('does not subtract reservations a second time from available stock', () => {
    expect(
      recommendPurchase({ ...input, stocks: [{ ...stock, reserved: 100 }] })
        .rawQuantity,
    ).toBe(10);
  });
  it.each([
    ['stock_missing', { stocks: [] }],
    [
      'stock_stale',
      {
        stocks: [
          { ...stock, observedAt: new Date(now - 300_000).toISOString() },
        ],
      },
    ],
    [
      'stock_stale',
      { stocks: [{ ...stock, observedAt: new Date(now + 1).toISOString() }] },
    ],
    ['stock_incomplete', { stocks: [{ ...stock, available: null }] }],
    ['stock_authority', { stocks: [{ ...stock, authoritative: false }] }],
    ['pack_size', { packSize: null }],
    ['minimum_quantity', { minimumQuantity: null }],
    ['lead_time', { leadTimeDays: null }],
    ['demand_incomplete', { demand: { ...input.demand, complete: false } }],
  ])('withholds a quantity when %s is unknown', (reason, change) => {
    const result = recommendPurchase({ ...input, ...change });
    expect(result.quantity).toBeNull();
    expect(result.missing).toContain(reason);
  });
  it('uses an active minimum/target rule without inventing demand or lead time', () => {
    const result = recommendPurchase({
      ...input,
      rule: { minimum: 15, target: 31 },
      leadTimeDays: null,
      demand: { ...input.demand, daily: null, complete: false },
    });
    expect(result).toMatchObject({
      rawQuantity: 21,
      quantity: 24,
      daysOfCover: null,
      missing: [],
    });
  });
  it('shows existing commitments without suggesting a second order', () => {
    expect(
      recommendPurchase({ ...input, committed: true }).quantity,
    ).toBeNull();
  });
  it('rejects incompatible units and unbounded quantities', () => {
    expect(
      recommendPurchase({ ...input, stocks: [stock, { ...stock, unit: 'kg' }] })
        .missing,
    ).toContain('unit_mismatch');
    expect(
      recommendPurchase({
        ...input,
        demand: { ...input.demand, daily: 1_000_000 },
      }),
    ).toMatchObject({ quantity: null, missing: ['quantity_limit'] });
  });
});

// Decimal price comparisons must not lose a smallest supported fraction at large values.
describe('exact purchasing amounts', () => {
  it('preserves the eight-digit fractional part beyond number precision', () => {
    expect(
      purchasingAmountUnits('100000000000000000.00000001') -
        purchasingAmountUnits('100000000000000000'),
    ).toBe(1n);
  });
});
