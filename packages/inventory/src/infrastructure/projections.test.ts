import { describe, expect, it } from 'vitest';

import { supersedes } from './projections.js';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';

describe('supersedes', () => {
  it('advances untimed stock reads to the later observation', () => {
    const first = {
      observationId: a,
      observedAt: '2026-09-20T00:00:00Z',
      sourceUpdatedAt: null,
    };
    const later = {
      ...first,
      observationId: b,
      observedAt: '2026-09-20T01:00:00Z',
    };

    expect(supersedes(later, first)).toBe(true);
    expect(supersedes(first, later)).toBe(false);
  });

  it('compares source update times strictly when both snapshots have them', () => {
    const current = {
      observationId: a,
      observedAt: '2026-09-20T00:00:00Z',
      sourceUpdatedAt: '2026-09-18T00:00:00Z',
    };

    expect(
      supersedes(
        { ...current, observationId: b, observedAt: '2026-09-21T00:00:00Z' },
        current,
      ),
    ).toBe(false);
    expect(
      supersedes(
        {
          observationId: b,
          observedAt: '2026-09-19T00:00:00Z',
          sourceUpdatedAt: '2026-09-18T00:00:01Z',
        },
        current,
      ),
    ).toBe(true);
  });
});
