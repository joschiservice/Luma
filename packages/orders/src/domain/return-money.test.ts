import { describe, expect, it } from 'vitest';

import type { ReturnAction } from './return-actions.js';
import type { ReturnCase } from './return-cases.js';
import type { ExchangeStep } from './return-exchanges.js';
import {
  observedReturnMoney,
  returnMoneyStep,
  unrequestedReturnMoney,
} from './return-money.js';

const proposal = (kind: 'refund' | 'exchange') => ({
  kind,
  lines: [],
  by: 'owner',
  at: '2026-10-12T10:00:00Z',
  evidence: { note: 'Checked', link: null },
});
const value = (kind: 'refund' | 'exchange' | null) =>
  ({
    id: 'case',
    revision: 3,
    proposal: kind ? proposal(kind) : null,
  }) as ReturnCase;
const refund = { id: 'refund', sent: true, requestedAt: 'r' } as ReturnAction;
const exchange = {
  id: 'exchange',
  sent: true,
  requestedAt: 'x',
} as ExchangeStep;

describe('returnMoneyStep', () => {
  it('follows the exchange for exchange proposals and the refund otherwise', () => {
    expect(returnMoneyStep(value('exchange'), refund, exchange)).toBe(exchange);
    expect(returnMoneyStep(value('refund'), refund, exchange)).toBe(refund);
    expect(returnMoneyStep(value(null), refund, exchange)).toBe(refund);
    expect(returnMoneyStep(value('exchange'), refund, null)).toBeNull();
  });
});

describe('unrequestedReturnMoney', () => {
  it('is complete evidence backed by the case revision', () => {
    expect(unrequestedReturnMoney(value('refund'), null)).toEqual({
      state: 'not_requested',
      readable: true,
      complete: true,
      observedAt: '2026-10-12T10:00:00Z',
      evidenceRefs: ['case:case:3'],
      requestedAt: null,
    });
  });
});

describe('observedReturnMoney', () => {
  const read = {
    payment: 'paid' as const,
    observedAt: '2026-10-12T11:00:00Z',
    evidenceRefs: ['provider:refund'],
  };

  it('is complete only for a known payment state with evidence', () => {
    expect(observedReturnMoney(read, 'r')).toEqual({
      state: 'paid',
      readable: true,
      complete: true,
      observedAt: read.observedAt,
      evidenceRefs: read.evidenceRefs,
      requestedAt: 'r',
    });
    expect(
      observedReturnMoney({ ...read, evidenceRefs: [] }, 'r').complete,
    ).toBe(false);
    expect(observedReturnMoney({ ...read, payment: null }, 'r')).toMatchObject({
      state: 'unknown',
      complete: false,
    });
    expect(
      observedReturnMoney({ ...read, payment: 'unknown' }, 'r').complete,
    ).toBe(false);
  });

  it('stays incomplete without a read', () => {
    expect(observedReturnMoney(null, 'r')).toEqual({
      state: 'unknown',
      readable: true,
      complete: false,
      observedAt: null,
      evidenceRefs: [],
      requestedAt: 'r',
    });
  });
});
