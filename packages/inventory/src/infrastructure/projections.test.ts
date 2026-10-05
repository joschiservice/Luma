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

  it('orders by source update time and advances later reads within the same update time', () => {
    const current = {
      observationId: a,
      observedAt: '2026-09-20T00:00:00Z',
      sourceUpdatedAt: '2026-09-18T00:00:00Z',
    };
    // Shopify reports whole seconds, so a second change in that second keeps its update time.
    const sameSecond = {
      ...current,
      observationId: b,
      observedAt: '2026-09-21T00:00:00Z',
    };

    expect(supersedes(sameSecond, current)).toBe(true);
    expect(supersedes(current, sameSecond)).toBe(false);
    expect(
      supersedes(
        {
          observationId: b,
          observedAt: '2026-09-21T00:00:00Z',
          sourceUpdatedAt: '2026-09-17T23:59:59Z',
        },
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
