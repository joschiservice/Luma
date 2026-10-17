import { describe, expect, it } from 'vitest';

import { replenishmentReviewContext } from './replenishment-review-context.js';
import type { SupplierProductTerms } from './supplier-terms.js';
import { effectiveSupplierTerms } from './supplier-terms.js';

const now = '2026-10-14T06:00:00.000Z';
const terms: SupplierProductTerms = {
  supplierId: 'supplier',
  supplierName: 'Supplier',
  skuId: 'sku',
  sku: 'MUG',
  revision: 1,
  lastReadAt: now,
  lastReadComplete: true,
  effective: {
    ...effectiveSupplierTerms([], now).effective,
    unitPrice: { amount: '0.10', currency: 'AUD', validFrom: null },
    leadTimeDays: 7,
  },
  observed: null,
  override: null,
  history: [],
};
const input = {
  productTitle: 'Mug',
  terms,
  demand: {
    daily: 2,
    units: 60,
    periodDays: 30,
    observedAt: now,
    evidenceRefs: ['read'],
    complete: true,
  },
  available: 4,
  quantity: 50,
  openOrders: [],
  now,
};

describe('replenishment approval context', () => {
  it('shows exact monetary totals, supplier lead time and before/after cover from complete demand', () => {
    expect(replenishmentReviewContext(input)).toMatchObject({
      unitPrice: { amount: '0.10', currency: 'AUD' },
      totalValue: { amount: '5', currency: 'AUD' },
      leadTimeDays: 7,
      dailySales: 2,
      coverBeforeDays: 2,
      coverAfterDays: 27,
      // The order reads behind the demand estimate, for the decision's evidence.
      demandEvidenceRefs: ['read'],
      unavailable: [],
    });
  });
  it('withholds stale prices, incomplete demand and cover instead of guessing', () => {
    expect(
      replenishmentReviewContext({
        ...input,
        terms: { ...terms, lastReadAt: '2026-10-12T06:00:00.000Z' },
        demand: { ...input.demand, complete: false },
      }),
    ).toMatchObject({
      unitPrice: null,
      totalValue: null,
      leadTimeDays: null,
      dailySales: null,
      coverBeforeDays: null,
      coverAfterDays: null,
      // Unknown demand cites no reads as if they supported an estimate.
      demandEvidenceRefs: [],
    });
    expect(
      replenishmentReviewContext({
        ...input,
        demand: { ...input.demand, daily: 0 },
      }),
    ).toMatchObject({
      dailySales: 0,
      coverBeforeDays: null,
      coverAfterDays: null,
    });
  });
});
