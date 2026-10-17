import { describe, expect, it } from 'vitest';

import type { Submission } from './commitments.js';
import {
  approvalExpired,
  isLiveSubmission,
  matchesSubmission,
  submissionActions,
  submissionBlockers,
} from './submissions.js';

const submission = (patch: Partial<Submission> = {}): Submission => ({
  id: 'submission',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  connectionId: 'connection',
  supplier: { externalId: 'S1', scopeKey: '' },
  requestedDeliveryDate: '2026-10-10',
  lines: [
    {
      lineId: 'a',
      sku: { externalId: 'TOTE', scopeKey: '' },
      quantity: 100,
      unit: 'each',
    },
    {
      lineId: 'b',
      sku: { externalId: 'BAG', scopeKey: '' },
      quantity: 2.5,
      unit: 'kg',
    },
  ],
  actionId: 'action',
  decisionId: 'decision',
  requestedBy: 'buyer',
  requestedAt: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-10-02T09:00:00.000Z',
  state: 'approval_required',
  externalOrder: null,
  submittedAt: null,
  decidedBy: null,
  decidedAt: null,
  failure: null,
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...patch,
});

const placed = (lines: [string | null, string][], supplier = 'S1') => ({
  supplier: { externalId: supplier },
  lines: lines.map(([sku, amount]) => ({
    sku: sku === null ? null : { externalId: sku },
    quantity: { amount },
  })),
});

describe('matchesSubmission', () => {
  it('accepts the approved supplier and lines in any order', () => {
    expect(
      matchesSubmission(
        submission(),
        placed([
          ['BAG', '2.500000'],
          ['TOTE', '100'],
        ]),
      ),
    ).toBe(true);
  });

  it('rejects another supplier, quantity, missing or extra line', () => {
    const lines: [string | null, string][] = [
      ['TOTE', '100'],
      ['BAG', '2.5'],
    ];
    expect(matchesSubmission(submission(), placed(lines, 'S2'))).toBe(false);
    expect(
      matchesSubmission(
        submission(),
        placed([
          ['TOTE', '99'],
          ['BAG', '2.5'],
        ]),
      ),
    ).toBe(false);
    expect(matchesSubmission(submission(), placed([['TOTE', '100']]))).toBe(
      false,
    );
    expect(
      matchesSubmission(submission(), placed([...lines, [null, '1']])),
    ).toBe(false);
  });
});

describe('submission state rules', () => {
  const now = Date.parse('2026-10-02T09:00:00.000Z');

  it('expires approval requests at their deadline only', () => {
    expect(approvalExpired(submission(), now)).toBe(true);
    expect(approvalExpired(submission(), now - 1)).toBe(false);
    expect(approvalExpired(submission({ state: 'approved' }), now)).toBe(false);
  });

  it('treats ended submissions as no longer occupying the order', () => {
    for (const state of [
      'rejected',
      'expired',
      'failed',
      'not_executed',
    ] as const)
      expect(isLiveSubmission({ state })).toBe(false);
    for (const state of [
      'approval_required',
      'uncertain',
      'submitted',
    ] as const)
      expect(isLiveSubmission({ state })).toBe(true);
  });
});

describe('submissionBlockers', () => {
  const ready = {
    order: { authority: 'luma' as const, status: 'draft' as const },
    executionAvailable: true,
    linked: true,
    connection: {
      label: 'JTL',
      status: 'active',
      canSubmit: true,
      canReadOrders: true,
    },
    lines: [{ sku: 'TOTE', mapped: true }],
  };

  it('is empty when the order can be sent', () => {
    expect(submissionBlockers(ready)).toEqual([]);
  });

  it('lists every blocker in the order a person should fix them', () => {
    expect(
      submissionBlockers({
        ...ready,
        order: { authority: 'external', status: 'closed' },
        executionAvailable: false,
        connection: { ...ready.connection, canReadOrders: false },
        lines: [
          { sku: 'TOTE', mapped: false },
          { sku: 'BAG', mapped: true },
        ],
      }),
    ).toEqual([
      'This order is managed in an external system.',
      'Only draft and open orders can be sent.',
      'Sending orders is unavailable on this server. Ask an administrator to enable execution.',
      'JTL is not allowed to create and read purchase orders. Reconnect it with purchase-order access.',
      'TOTE has no linked item in JTL. Link the SKU in Products first.',
    ]);
  });

  it('reports a missing or inactive connection only after looking it up', () => {
    const inactive =
      'The supplier’s purchasing-system connection is not active. Check the connection in Apps.';
    expect(submissionBlockers({ ...ready, connection: null })).toEqual([
      inactive,
    ]);
    expect(
      submissionBlockers({
        ...ready,
        connection: { ...ready.connection, status: 'paused' },
      }),
    ).toEqual([inactive]);
    expect(
      submissionBlockers({
        ...ready,
        linked: false,
        connection: undefined,
        lines: [],
      }),
    ).toEqual([
      'Link this supplier to its purchasing-system record before sending orders.',
    ]);
  });

  it('names the purchasing system generically without a connection', () => {
    expect(
      submissionBlockers({
        ...ready,
        executionAvailable: false,
        connection: undefined,
        lines: [{ sku: 'TOTE', mapped: false }],
      }),
    ).toContain(
      'TOTE has no linked item in the purchasing system. Link the SKU in Products first.',
    );
  });
});

describe('submissionActions', () => {
  const reader = {
    decision: null,
    expired: false,
    observeOnly: false,
    requester: false,
    manager: true,
    approver: true,
  };

  it('lets another approver approve, and the requester only with self-approval allowed', () => {
    expect(submissionActions({ ...reader, submission: submission() })).toEqual({
      state: 'approval_required',
      canApprove: true,
      canSend: false,
      canCheck: false,
      message:
        'Check the supplier, lines and requested date before approving. Luma places the order in the purchasing system right after approval.',
    });
    const own = submissionActions({
      ...reader,
      requester: true,
      submission: submission(),
    });
    expect(own.canApprove).toBe(false);
    expect(own.message).toBe(
      'Waiting for someone else who can approve changes to approve sending this order.',
    );
    expect(
      submissionActions({
        ...reader,
        requester: true,
        decision: { requireIndependentApproval: false },
        submission: submission(),
      }).canApprove,
    ).toBe(true);
    expect(
      submissionActions({
        ...reader,
        decision: { approval: { outcome: 'approved' } },
        submission: submission(),
      }).canApprove,
    ).toBe(false);
  });

  it('shows expired and observe-only submissions as nothing sent', () => {
    expect(
      submissionActions({ ...reader, expired: true, submission: submission() }),
    ).toMatchObject({
      state: 'expired',
      canApprove: false,
      message: 'The approval request expired. Nothing was sent.',
    });
    expect(
      submissionActions({
        ...reader,
        observeOnly: true,
        requester: true,
        submission: submission({ state: 'approved' }),
      }),
    ).toMatchObject({
      canSend: false,
      message:
        'Observe-only. Would run when writes are enabled. Nothing was sent.',
    });
  });

  it('lets only the requester send and managers check uncertain submissions', () => {
    const approved = submission({ state: 'approved' });
    expect(
      submissionActions({ ...reader, requester: true, submission: approved })
        .canSend,
    ).toBe(true);
    expect(submissionActions({ ...reader, submission: approved }).canSend).toBe(
      false,
    );
    const uncertain = submission({ state: 'uncertain' });
    expect(
      submissionActions({ ...reader, submission: uncertain }).canCheck,
    ).toBe(true);
    expect(
      submissionActions({ ...reader, manager: false, submission: uncertain })
        .canCheck,
    ).toBe(false);
  });

  it('leaves email submissions to the Operations Inbox and explains failures', () => {
    expect(
      submissionActions({
        ...reader,
        requester: true,
        submission: submission({ channel: 'email', state: 'uncertain' }),
      }),
    ).toMatchObject({ canApprove: false, canSend: false, canCheck: false });
    expect(
      submissionActions({
        ...reader,
        submission: submission({ state: 'failed', failure: 'Rejected SKU' }),
      }).message,
    ).toBe('Rejected SKU');
  });
});
