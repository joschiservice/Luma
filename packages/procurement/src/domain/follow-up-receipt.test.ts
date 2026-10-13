import { expect, it } from 'vitest';

import type { FollowUp } from './commitments.js';
import {
  followUpReceiptMatches,
  supplierFollowUpNote,
} from './follow-up-receipt.js';

const expected = {
  tenantId: 'tenant',
  orderId: 'order',
  followUpId: 'receipt',
  key: 'overdue',
  nextCheckAt: '2026-10-13T12:30:00.000Z',
  requestedBy: 'requester',
};
const receipt: FollowUp = {
  id: expected.followUpId,
  tenantId: expected.tenantId,
  purchaseOrderId: expected.orderId,
  key: expected.key,
  response: 'following_up',
  note: supplierFollowUpNote(expected.nextCheckAt),
  nextCheckAt: expected.nextCheckAt,
  respondedBy: expected.requestedBy,
  respondedAt: '2026-10-13T12:00:00Z',
};

it('requires the exact independently read note; colliding identifiers never prove the expected effect', () => {
  expect(followUpReceiptMatches(expected, receipt)).toBe(true);
  expect(followUpReceiptMatches(expected, undefined)).toBe(false);
  for (const changed of [
    { tenantId: 'foreign' },
    { purchaseOrderId: 'other' },
    { key: 'new occurrence' },
    { response: 'accepted' as const },
    { note: 'A manual note with the same ID' },
    { nextCheckAt: null },
    { nextCheckAt: '2026-10-13T13:00:00Z' },
    { respondedBy: 'another member' },
  ])
    expect(followUpReceiptMatches(expected, { ...receipt, ...changed })).toBe(
      false,
    );
});
