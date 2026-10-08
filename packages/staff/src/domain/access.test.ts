import { describe, expect, it } from 'vitest';

import type { StaffContext } from './access.js';
import { requireRecentStaffSession, requireStaffPermission } from './access.js';

const context: StaffContext = {
  userId: 'staff',
  sessionId: 'session',
  sessionCreatedAt: new Date('2026-01-01T00:00:00Z'),
  permissions: ['staff.workspace.inspect'],
  requestId: 'test',
};
describe('staff authorization', () => {
  it('does not derive staff powers from customer roles', () => {
    expect(() =>
      requireStaffPermission(context, 'staff.sessions.revoke'),
    ).toThrow('Staff permission required');
  });
  it('requires recent authentication and rejects future timestamps', () => {
    expect(() =>
      requireRecentStaffSession(context, new Date('2026-01-01T00:16:00Z')),
    ).toThrow();
    expect(() =>
      requireRecentStaffSession(context, new Date('2025-12-31T23:59:59Z')),
    ).toThrow();
    expect(() =>
      requireRecentStaffSession(context, new Date('2026-01-01T00:14:00Z')),
    ).not.toThrow();
  });
});
