import { describe, expect, it } from 'vitest';

import { closureNotice } from './closure';

describe('workspace closure notice', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const closed = {
    status: 'closed' as const,
    dataDeletionAt: null,
    dataDeletedAt: null,
  };

  it('names the announced deletion date, then the deletion in progress and its completion', () => {
    expect(closureNotice({ ...closed, status: 'active' }, now)).toBeNull();
    expect(closureNotice(closed, now)).toBe(
      'Luma will announce when its data is deleted.',
    );
    expect(
      closureNotice({ ...closed, dataDeletionAt: '2027-01-16T00:00:00Z' }, now),
    ).toBe(
      'Data will be deleted on 16 Jan 2027. Contact Luma support to reopen it before then.',
    );
    expect(
      closureNotice({ ...closed, dataDeletionAt: '2026-10-01T00:00:00Z' }, now),
    ).toBe('Luma is deleting its data.');
    expect(
      closureNotice(
        {
          ...closed,
          dataDeletionAt: '2026-10-01T00:00:00Z',
          dataDeletedAt: '2026-10-02T00:00:00Z',
        },
        now,
      ),
    ).toBe('Data was deleted on 2 Oct 2026.');
  });
});
