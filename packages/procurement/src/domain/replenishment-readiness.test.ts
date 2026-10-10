import { describe, expect, it } from 'vitest';

import { stockUnusableReason } from './metrics.js';
import {
  ruleState,
  suspendedOwnerReadiness,
} from './replenishment-readiness.js';

const now = Date.parse('2026-10-03T08:00:00.000Z');
const stock = (observedAt: string, available: number | null = 4) => ({
  available,
  observedAt,
  deleted: false,
});

describe('ruleState', () => {
  it('is ready only with fresh numeric stock', () => {
    expect(
      ruleState(
        true,
        stockUnusableReason(stock('2026-10-03T07:58:00.000Z'), now),
      ),
    ).toMatchObject({ state: 'ready', code: 'ready' });
  });

  it('blocks a rule whose source stopped reporting instead of treating it as healthy', () => {
    expect(
      ruleState(
        true,
        stockUnusableReason(stock('2026-10-03T07:50:00.000Z'), now),
      ),
    ).toMatchObject({ state: 'blocked', code: 'expired' });
    expect(ruleState(true, stockUnusableReason(undefined, now))).toMatchObject({
      state: 'blocked',
      code: 'missing',
    });
    expect(
      ruleState(
        true,
        stockUnusableReason(stock('2026-10-03T07:59:00.000Z', null), now),
      ),
    ).toMatchObject({ state: 'blocked', code: 'nonnumeric' });
  });

  it('reports a revoked rule as revoked whatever its stock', () => {
    expect(ruleState(false, null)).toMatchObject({ state: 'revoked' });
  });
});

describe('suspendedOwnerReadiness', () => {
  it('blocks only when every active rule needs a new owner', () => {
    expect(suspendedOwnerReadiness(0, 3)).toBeNull();
    expect(suspendedOwnerReadiness(1, 3)).toMatchObject({
      severity: 'degrading',
      message: expect.stringMatching(/^1 stock rule needs a new owner\./),
    });
    expect(suspendedOwnerReadiness(3, 3)).toMatchObject({
      severity: 'blocking',
      message: expect.stringMatching(/^3 stock rules need a new owner\./),
    });
    expect(suspendedOwnerReadiness(1, 1, true)?.message).toMatch(
      /^This rule needs a new owner\./,
    );
  });
});
