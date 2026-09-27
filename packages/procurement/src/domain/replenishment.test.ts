import { describe, expect, it } from 'vitest';

import { planReplenishment } from './replenishment.js';

const now = Date.parse('2026-09-27T10:00:00Z');
const rule = { minimum: 10, target: 50, approvalQuantity: 40 };
const stock = {
  available: 5,
  observedAt: new Date(now - 1000).toISOString(),
  deleted: false,
};

describe('replenishment rule', () => {
  it('replenishes to target and raises approval risk only above the configured limit', () => {
    expect(planReplenishment(rule, stock, false, now)).toMatchObject({
      eligible: true,
      quantity: 45,
      approvalRequired: true,
    });
    expect(
      planReplenishment({ ...rule, approvalQuantity: 45 }, stock, false, now)
        .approvalRequired,
    ).toBe(false);
    expect(
      planReplenishment(rule, { ...stock, available: 10 }, false, now),
    ).toMatchObject({ eligible: false, quantity: 0 });
  });
  it('stops on open commitments, missing, deleted, stale or future stock', () => {
    expect(planReplenishment(rule, stock, true, now).eligible).toBe(false);
    for (const changed of [
      { available: null },
      { available: NaN },
      { deleted: true },
      { observedAt: new Date(now - 300000).toISOString() },
      { observedAt: new Date(now + 1).toISOString() },
    ])
      expect(
        planReplenishment(rule, { ...stock, ...changed }, false, now).eligible,
      ).toBe(false);
  });
  it('rounds to whole units and bounds negative-stock replenishment', () => {
    expect(
      planReplenishment(rule, { ...stock, available: 4.5 }, false, now)
        .quantity,
    ).toBe(46);
    expect(
      planReplenishment(rule, { ...stock, available: -1000000 }, false, now)
        .eligible,
    ).toBe(false);
  });
});
