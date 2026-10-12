import { describe, expect, it } from 'vitest';

import type { ReturnCase } from './return-cases.js';
import {
  type ReturnDeadlinePolicy,
  type ReturnMoneyEvidence,
  returnWaitingConditions,
} from './return-waiting.js';

const now = new Date('2026-10-12T12:00:00Z');
const base: ReturnCase = {
  id: 'case',
  tenantId: 'tenant',
  orderId: 'order',
  connectionId: 'shop',
  sourceReturnId: null,
  state: 'open',
  assigneeId: null,
  openedBy: 'owner',
  openedAt: '2026-10-10T12:00:00Z',
  updatedAt: '2026-10-10T12:00:00Z',
  revision: 1,
  cancellation: null,
  lines: [
    {
      orderLineId: 'line',
      quantity: 2,
      title: null,
      sku: null,
      reason: 'other',
      note: null,
    },
  ],
  receipt: null,
  inspection: null,
  proposal: null,
};
const policy: ReturnDeadlinePolicy = {
  revision: 1,
  enabled: true,
  receiptHours: 24,
  inspectionHours: 4,
  financialHours: 8,
  sourceMaxAgeSeconds: 300,
  updatedBy: 'owner',
  updatedAt: base.openedAt,
};
const noMoney: ReturnMoneyEvidence = {
  state: 'not_requested',
  readable: true,
  complete: true,
  observedAt: null,
  evidenceRefs: [],
  requestedAt: null,
};
const receipt = {
  by: 'warehouse',
  at: '2026-10-12T10:00:00Z',
  evidence: { note: 'Counted', link: null },
  lines: [{ orderLineId: 'line', received: 1 }],
};
const inspection = {
  by: 'warehouse',
  at: '2026-10-12T10:30:00Z',
  evidence: { note: 'Inspected', link: null },
  lines: [{ orderLineId: 'line', resellable: 1, damaged: 0 }],
};
const proposal = {
  by: 'owner',
  at: '2026-10-12T11:00:00Z',
  evidence: { note: 'Reviewed', link: null },
  kind: 'refund' as const,
  lines: [{ orderLineId: 'line', restock: 1 }],
};

describe('return deadline evidence', () => {
  it('leaves dates unset until the merchant enables reviewed deadlines', () => {
    expect(
      returnWaitingConditions(
        base,
        { ...policy, enabled: false },
        noMoney,
        now,
      ),
    ).toEqual({ conditions: [], verified: [] });
  });
  it('keeps missing physical units and inspection separate and anchors each to the actual case event', () => {
    const result = returnWaitingConditions(
      { ...base, receipt },
      policy,
      noMoney,
      now,
    );
    expect(result.conditions).toMatchObject([
      {
        phase: 'receipt',
        anchorAt: base.openedAt,
        anchorOrigin: 'case_opened',
        reason: 'missing_units',
        units: 1,
        dueAt: '2026-10-11T12:00:00.000Z',
      },
      {
        phase: 'inspection',
        anchorAt: receipt.at,
        anchorOrigin: 'receipt_recorded',
        reason: 'inspection',
        units: 1,
        dueAt: '2026-10-12T14:00:00.000Z',
      },
    ]);
    expect(result.verified).not.toContain('receipt');
  });
  it.each(['pending', 'failed', 'partial'] as const)(
    'does not call %s money settled',
    (state) => {
      const result = returnWaitingConditions(
        { ...base, receipt, inspection, proposal },
        policy,
        {
          ...noMoney,
          state,
          observedAt: now.toISOString(),
          evidenceRefs: ['observation'],
          requestedAt: '2026-10-12T01:00:00Z',
        },
        now,
      );
      expect(
        result.conditions.find((c) => c.phase === 'financial'),
      ).toMatchObject({
        reason: `${state}_money`,
        anchorOrigin: 'action_requested',
        dueAt: '2026-10-12T09:00:00.000Z',
      });
      expect(result.verified).not.toContain('financial');
    },
  );
  it('requires complete fresh evidence and current access before late payment retires a wait', () => {
    const value = { ...base, receipt, inspection, proposal };
    const paid = {
      ...noMoney,
      state: 'paid' as const,
      observedAt: now.toISOString(),
      evidenceRefs: ['observation'],
    };
    expect(
      returnWaitingConditions(value, policy, paid, now).verified,
    ).toContain('financial');
    for (const evidence of [
      { ...paid, complete: false },
      { ...paid, readable: false },
      { ...paid, observedAt: '2026-10-12T11:00:00Z' },
      { ...paid, observedAt: '2026-10-12T13:00:00Z' },
    ])
      expect(
        returnWaitingConditions(value, policy, evidence, now).verified,
      ).not.toContain('financial');
  });
  it('never treats a proposal as money or an unreceived unit as a financial entitlement', () => {
    const result = returnWaitingConditions(
      { ...base, receipt, inspection, proposal },
      policy,
      noMoney,
      now,
    );
    expect(
      result.conditions.find((c) => c.phase === 'financial'),
    ).toMatchObject({
      reason: 'not_requested',
      anchorAt: proposal.at,
      anchorOrigin: 'resolution_proposed',
    });
    const empty = { ...receipt, lines: [{ orderLineId: 'line', received: 0 }] };
    expect(
      returnWaitingConditions(
        { ...base, receipt: empty, inspection, proposal },
        policy,
        noMoney,
        now,
      ).conditions.map((c) => c.phase),
    ).toEqual(['receipt']);
  });
});
