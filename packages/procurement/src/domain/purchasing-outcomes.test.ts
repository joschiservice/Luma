import { expect, it } from 'vitest';

import { evaluatePurchasingOutcome } from './purchasing-outcomes.js';

const at = (minute: number) =>
  new Date(Date.parse('2026-10-13T09:00:00Z') + minute * 60_000).toISOString();
const read = (minute: number, available: number) => ({
  observationId: `read-${minute}`,
  observedAt: at(minute),
  available,
  complete: true,
});
const input = {
  decidedAt: at(0),
  decision: 'followed' as const,
  receipt: { observedAt: at(9), verified: true, evidenceRefs: ['receipt'] },
  stocks: [read(0, 10), read(4, 6), read(8, 2), read(10, 42)],
  target: 40,
  now: Date.parse(at(11)),
};
it('reports stock stayed available only after independent receipt and fresh stock evidence', () => {
  expect(evaluatePurchasingOutcome(input)).toMatchObject({
    state: 'available_through_receipt',
    aboveTarget: 2,
    complete: true,
  });
  expect(
    evaluatePurchasingOutcome({
      ...input,
      receipt: { ...input.receipt, verified: false },
    }),
  ).toMatchObject({ state: 'unknown', reason: 'receipt_unverified' });
});
it('keeps gaps, incomplete reads and unobserved receipts unknown', () => {
  for (const stocks of [
    [read(0, 10), read(10, 42)],
    [read(0, 10), { ...read(4, 6), complete: false }, read(8, 2), read(10, 42)],
    [],
  ])
    expect(evaluatePurchasingOutcome({ ...input, stocks }).state).toBe(
      'unknown',
    );
});
it('reports an ignored recommendation followed by an observed stockout without calling it a prevented loss', () => {
  expect(
    evaluatePurchasingOutcome({
      ...input,
      decision: 'ignored',
      receipt: null,
      stocks: [read(0, 10), read(4, 0), read(8, 0), read(10, 5)],
    }),
  ).toMatchObject({
    state: 'stockout_observed',
    stockoutAt: at(4),
    observedStockoutMinutes: 6,
  });
});
it('does not invent duration across an observation gap', () => {
  expect(
    evaluatePurchasingOutcome({ ...input, stocks: [read(0, 0), read(20, 5)] }),
  ).toMatchObject({
    state: 'stockout_observed',
    observedStockoutMinutes: null,
  });
});
