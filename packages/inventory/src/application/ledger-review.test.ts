import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { LedgerReview } from './ledger.js';
import {
  canReviewLedgerChange,
  ledgerReviewPermissions,
} from './ledger-review.js';

let ids = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const tenantId = nextId();

function contextFor(userId: string, role: 'owner' | 'member') {
  return makeTenantContext(
    { userId, sessionId: nextId() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    builtInMembership({ id: nextId(), organizationId: tenantId, userId }, role),
    nextId(),
  );
}

const preparer = nextId();
const correction = {
  preparedBy: preparer,
  command: {},
} as Pick<LedgerReview, 'command' | 'preparedBy'>;
const receipt = {
  preparedBy: preparer,
  command: { purchaseReceipt: { purchaseOrderId: 'po' } },
} as Pick<LedgerReview, 'command' | 'preparedBy'>;

describe('ledgerReviewPermissions', () => {
  it('adds procurement management for purchase receipts', () => {
    expect(ledgerReviewPermissions(correction)).toEqual([
      'inventory.read',
      'inventory.approve',
    ]);
    expect(ledgerReviewPermissions(receipt)).toEqual([
      'inventory.read',
      'inventory.approve',
      'procurement.manage',
    ]);
  });
});

describe('canReviewLedgerChange', () => {
  it('lets another permitted member review', () => {
    expect(canReviewLedgerChange(contextFor(nextId(), 'owner'), receipt)).toBe(
      true,
    );
  });

  it('never lets the preparer review their own change', () => {
    expect(canReviewLedgerChange(contextFor(preparer, 'owner'), receipt)).toBe(
      false,
    );
  });

  it('requires the review permissions', () => {
    expect(
      canReviewLedgerChange(contextFor(nextId(), 'member'), correction),
    ).toBe(false);
  });
});
