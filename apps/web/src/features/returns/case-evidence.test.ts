import { describe, expect, it } from 'vitest';

import { returnEvidenceFreshness } from './case-evidence';
import { detail } from './returns-fixtures';

const now = '2026-10-11T12:00:00.000Z';
const source = {
  ...detail,
  item: { ...detail.item, observedAt: now },
  source: {
    ...detail.source!,
    status: 'active' as const,
    access: 'granted' as const,
    failing: false,
  },
  refunds: detail.refunds.map((r) => ({ ...r, observedAt: now })),
};

describe('customer-safe return evidence', () => {
  it('requires fresh payment reads as well as a healthy return read', () => {
    expect(returnEvidenceFreshness(source, now)).toBe('fresh');
    expect(
      returnEvidenceFreshness(
        {
          ...source,
          refunds: [
            { ...source.refunds[0]!, observedAt: '2026-10-09T12:00:00.000Z' },
          ],
        },
        now,
      ),
    ).toBe('stale');
    expect(
      returnEvidenceFreshness(
        { ...source, source: { ...source.source, failing: true } },
        now,
      ),
    ).toBe('stale');
    expect(
      returnEvidenceFreshness(
        {
          ...source,
          item: { ...source.item, observedAt: '2026-10-11T12:01:00.000Z' },
        },
        now,
      ),
    ).toBe('stale');
    expect(returnEvidenceFreshness(undefined, now)).toBe('missing');
  });
});
