import { describe, expect, it } from 'vitest';

import { formatWorkspaceDateTime, formatWorkspaceTime } from './workspace-date';

describe('workspace times', () => {
  it('uses the specified zone independently of the browser default', () => {
    expect(formatWorkspaceTime('2026-10-14T05:20:00Z', 'UTC')).toBe(
      '05:20 UTC',
    );
    expect(formatWorkspaceDateTime('2026-10-14T05:20:00Z', 'UTC')).toContain(
      '05:20 UTC',
    );
  });
  it('handles Australian daylight saving and half-hour offsets', () => {
    expect(
      formatWorkspaceTime('2026-10-14T05:20:00Z', 'Australia/Sydney'),
    ).toMatch(/^16:20 /);
    expect(
      formatWorkspaceTime('2026-07-14T05:20:00Z', 'Australia/Sydney'),
    ).toMatch(/^15:20 /);
    expect(
      formatWorkspaceTime('2026-10-14T05:20:00Z', 'Australia/Adelaide'),
    ).toMatch(/^15:50 /);
    expect(
      formatWorkspaceTime('2026-10-14T05:20:00Z', 'Australia/Perth'),
    ).toMatch(/^13:20 /);
  });
});
