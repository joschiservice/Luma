import { describe, expect, it } from 'vitest';

import { presentReturnCase } from './return-case-decisions.js';

const caseId = '1b0f8a4e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const creationId = '2c1e9b5f-3d4e-4f60-9b0c-1d2e3f4a5b6c';
const exchangeId = '3d2f0c6a-4e5f-4071-8c1d-2e3f4a5b6c7d';
const waitId = '4e3a1d7b-5f60-4182-9d2e-3f4a5b6c7d8e';
const settlementId = '5f4b2e8c-6071-4293-8e3f-4a5b6c7d8e9f';

const base = {
  case: {
    id: caseId,
    orderId: '6a5c3f9d-7182-43a4-9f40-5b6c7d8e9fa0',
    orderNumber: '#1001',
    units: 2,
    stage: 'received',
    openedAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
  creation: null,
  assignment: null,
  canManage: true,
};

const creation = (state: string) => ({
  id: creationId,
  state,
  expiresAt: '2026-10-02T08:00:00.000Z',
  requestedAt: '2026-10-01T08:10:00.000Z',
  requestedBy: { id: 'requester' },
  canApprove: true,
  canSend: false,
  observeOnly: false,
});

const waiting = {
  id: waitId,
  dueAt: '2026-10-01T12:00:00.000Z',
  reason: 'pending_money',
  observedAt: '2026-10-01T09:00:00.000Z',
  ownerId: 'owner',
};

describe('return case decision evidence', () => {
  it('cites a creation while it waits on a person', () => {
    expect(
      presentReturnCase({
        ...base,
        creation: creation('approval_required'),
        waiting,
      }).citedEvidence,
    ).toEqual({ subject: { kind: 'return_creation', id: creationId } });
  });

  it('cites the wait that is due, rather than a finished creation', () => {
    const item = presentReturnCase({
      ...base,
      creation: creation('verified'),
      waiting,
      settlement: { kind: 'settlement', id: settlementId },
    });

    expect(item.deadline).toBe(waiting.dueAt);
    expect(item.citedEvidence).toEqual({
      subject: { kind: 'return_wait', id: waitId },
    });
  });

  it('cites an unresolved exchange completion check before a wait', () => {
    expect(
      presentReturnCase({
        ...base,
        waiting,
        completion: {
          exchangeId,
          state: 'unresolved',
          ownerId: 'owner',
          checkedAt: '2026-10-01T09:30:00.000Z',
          checks: [{ id: 'stock', verified: false }],
        },
      }).citedEvidence,
    ).toEqual({ subject: { kind: 'return_exchange', id: exchangeId } });
  });

  it('falls back to the latest settlement step, then the last creation', () => {
    expect(
      presentReturnCase({
        ...base,
        creation: creation('verified'),
        settlement: { kind: 'exchange_step', id: settlementId },
      }).citedEvidence,
    ).toEqual({
      subject: { kind: 'return_exchange_step', id: settlementId },
    });
    expect(
      presentReturnCase({ ...base, creation: creation('verified') })
        .citedEvidence,
    ).toEqual({ subject: { kind: 'return_creation', id: creationId } });
    expect(presentReturnCase(base).citedEvidence).toBeUndefined();
  });
});
