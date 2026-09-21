import { expect, it } from 'vitest';

import { approvalBlocksRenewal } from './proposal-renewal';

it('permits a new independent decision only after an approval expires', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  expect(approvalBlocksRenewal(null, now)).toBe(false);
  expect(
    approvalBlocksRenewal(
      { outcome: 'approved', expiresAt: new Date(now + 1).toISOString() },
      now,
    ),
  ).toBe(true);
  expect(
    approvalBlocksRenewal(
      { outcome: 'approved', expiresAt: new Date(now).toISOString() },
      now,
    ),
  ).toBe(false);
});

it('preserves rejections even after expiry and fails closed for invalid approval dates', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  expect(
    approvalBlocksRenewal(
      { outcome: 'rejected', expiresAt: new Date(now - 1).toISOString() },
      now,
    ),
  ).toBe(true);
  expect(
    approvalBlocksRenewal({ outcome: 'approved', expiresAt: 'invalid' }, now),
  ).toBe(true);
});
