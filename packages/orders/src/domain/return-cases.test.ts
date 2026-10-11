import { describe, expect, it } from 'vitest';

import {
  cancelCase,
  checkOpenLines,
  lineAvailability,
  proposeResolution,
  recordInspection,
  recordReceipt,
  type ReturnCase,
  ReturnCaseError,
  returnCaseStage,
  type StoreReturn,
} from './return-cases.js';

const lines = [
  { id: 'line-a', quantity: '3', cancelledQuantity: null },
  { id: 'line-b', quantity: '2', cancelledQuantity: '1' },
];

const evidence = { note: 'Checked at the bench', link: null };

const decided = { by: 'user-1', at: '2026-10-11T10:00:00.000Z', evidence };

function returnCase(
  id: string,
  quantities: Record<string, number>,
  patch: Partial<ReturnCase> = {},
): ReturnCase {
  return {
    id,
    tenantId: 'tenant',
    orderId: 'order',
    connectionId: 'connection',
    sourceReturnId: null,
    state: 'open',
    lines: Object.entries(quantities).map(([orderLineId, quantity]) => ({
      orderLineId,
      title: null,
      sku: null,
      quantity,
      reason: 'damaged',
      note: null,
    })),
    assigneeId: null,
    receipt: null,
    inspection: null,
    proposal: null,
    openedBy: 'user-1',
    openedAt: '2026-10-11T09:00:00.000Z',
    cancellation: null,
    revision: 1,
    updatedAt: '2026-10-11T09:00:00.000Z',
    ...patch,
  };
}

function storeReturn(
  entityId: string,
  quantities: Record<string, string>,
  status: StoreReturn['status'] = 'open',
): StoreReturn {
  return {
    entityId,
    connectionId: 'connection',
    status,
    lines: Object.entries(quantities).map(([orderLineId, quantity]) => ({
      orderLineId,
      quantity,
    })),
  };
}

const rejects = (operation: () => unknown, code: ReturnCaseError['code']) => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ReturnCaseError);
    expect((error as ReturnCaseError).code).toBe(code);

    return;
  }
  throw new Error('Expected the rule to reject the request');
};

describe('line availability', () => {
  it('counts two partial returns on one order once each', () => {
    const first = returnCase('case-1', { 'line-a': 1 });
    const second = returnCase('case-2', { 'line-a': 1, 'line-b': 1 });
    const available = lineAvailability(lines, [first, second], []);

    expect(available.get('line-a')).toEqual({
      ordered: 3,
      inCases: 2,
      inStoreReturns: 0,
      returnable: 1,
    });
    // One of two units was cancelled before fulfillment.
    expect(available.get('line-b')).toEqual({
      ordered: 1,
      inCases: 1,
      inStoreReturns: 0,
      returnable: 0,
    });
  });

  it('counts a store return only through the case that links it', () => {
    const linked = storeReturn('return-1', { 'line-a': '2' });
    const other = storeReturn('return-2', { 'line-a': '1' });
    const working = returnCase(
      'case-1',
      { 'line-a': 2 },
      { sourceReturnId: 'return-1' },
    );

    expect(
      lineAvailability(lines, [working], [linked, other]).get('line-a'),
    ).toEqual({ ordered: 3, inCases: 2, inStoreReturns: 1, returnable: 0 });
  });

  it('frees units of cancelled cases and ignores declined store returns', () => {
    const cancelled = returnCase(
      'case-1',
      { 'line-a': 3 },
      { state: 'cancelled', sourceReturnId: 'return-1' },
    );
    const available = lineAvailability(
      lines,
      [cancelled],
      [
        storeReturn('return-1', { 'line-a': '1' }),
        storeReturn('return-2', { 'line-a': '2' }, 'declined'),
      ],
    );

    expect(available.get('line-a')?.returnable).toBe(2);
  });

  it('excludes the case being checked', () => {
    const own = returnCase('case-1', { 'line-a': 3 });

    expect(
      lineAvailability(lines, [own], [], 'case-1').get('line-a')?.returnable,
    ).toBe(3);
  });
});

describe('opening a case', () => {
  const availability = lineAvailability(lines, [], []);

  it('refuses more units than are returnable', () => {
    rejects(
      () =>
        checkOpenLines(returnCase('c', { 'line-b': 2 }).lines, availability),
      'conflict',
    );
  });

  it('refuses partial units, repeated lines and unknown lines', () => {
    rejects(
      () =>
        checkOpenLines(returnCase('c', { 'line-a': 1.5 }).lines, availability),
      'invalid',
    );
    const line = returnCase('c', { 'line-a': 1 }).lines[0]!;
    rejects(() => checkOpenLines([line, line], availability), 'invalid');
    rejects(
      () => checkOpenLines(returnCase('c', { other: 1 }).lines, availability),
      'invalid',
    );
    rejects(() => checkOpenLines([], availability), 'invalid');
  });
});

describe('receipt, inspection and resolution', () => {
  const open = returnCase('case-1', { 'line-a': 2, 'line-b': 1 });
  const received = recordReceipt(open, {
    ...decided,
    lines: [
      { orderLineId: 'line-a', received: 2 },
      { orderLineId: 'line-b', received: 0 },
    ],
  });
  const inspected = recordInspection(received, {
    ...decided,
    lines: [
      { orderLineId: 'line-a', resellable: 1, damaged: 1 },
      { orderLineId: 'line-b', resellable: 0, damaged: 0 },
    ],
  });

  it('moves through the stages', () => {
    expect(returnCaseStage(open)).toBe('awaiting_receipt');
    expect(returnCaseStage(received)).toBe('awaiting_inspection');
    expect(returnCaseStage(inspected)).toBe('awaiting_proposal');
    expect(
      returnCaseStage(
        proposeResolution(inspected, {
          ...decided,
          kind: 'refund',
          lines: [
            { orderLineId: 'line-a', restock: 1 },
            { orderLineId: 'line-b', restock: 0 },
          ],
        }),
      ),
    ).toBe('proposed');
  });

  it('never proposes damaged or missing units for restock', () => {
    rejects(
      () =>
        proposeResolution(inspected, {
          ...decided,
          kind: 'refund',
          lines: [
            { orderLineId: 'line-a', restock: 2 },
            { orderLineId: 'line-b', restock: 0 },
          ],
        }),
      'conflict',
    );
    rejects(
      () =>
        proposeResolution(inspected, {
          ...decided,
          kind: 'exchange',
          lines: [
            { orderLineId: 'line-a', restock: 0 },
            { orderLineId: 'line-b', restock: 1 },
          ],
        }),
      'conflict',
    );
  });

  it('restocks nothing on a rejection', () => {
    rejects(
      () =>
        proposeResolution(inspected, {
          ...decided,
          kind: 'rejection',
          lines: [
            { orderLineId: 'line-a', restock: 1 },
            { orderLineId: 'line-b', restock: 0 },
          ],
        }),
      'invalid',
    );
  });

  it('judges exactly the received units', () => {
    rejects(
      () =>
        recordInspection(received, {
          ...decided,
          lines: [
            { orderLineId: 'line-a', resellable: 2, damaged: 1 },
            { orderLineId: 'line-b', resellable: 0, damaged: 0 },
          ],
        }),
      'invalid',
    );
    rejects(
      () => recordInspection(open, { ...decided, lines: [] }),
      'conflict',
    );
  });

  it('refuses receipts above the requested units or for other lines', () => {
    rejects(
      () =>
        recordReceipt(open, {
          ...decided,
          lines: [
            { orderLineId: 'line-a', received: 3 },
            { orderLineId: 'line-b', received: 0 },
          ],
        }),
      'invalid',
    );
    rejects(
      () =>
        recordReceipt(open, {
          ...decided,
          lines: [{ orderLineId: 'line-a', received: 1 }],
        }),
      'invalid',
    );
  });

  it('clears later decisions when an earlier one is recorded again', () => {
    const corrected = recordReceipt(inspected, {
      ...decided,
      lines: [
        { orderLineId: 'line-a', received: 1 },
        { orderLineId: 'line-b', received: 1 },
      ],
    });

    expect(corrected.inspection).toBeNull();
    expect(corrected.proposal).toBeNull();
  });

  it('refuses decisions on a cancelled case', () => {
    const cancelled = cancelCase(open, {
      by: 'user-1',
      at: decided.at,
      reason: 'Opened twice',
    });

    expect(returnCaseStage(cancelled)).toBe('cancelled');
    rejects(
      () =>
        recordReceipt(cancelled, {
          ...decided,
          lines: [
            { orderLineId: 'line-a', received: 2 },
            { orderLineId: 'line-b', received: 1 },
          ],
        }),
      'conflict',
    );
  });
});
