import { describe, expect, it } from 'vitest';

import { replacesProfile } from './profiles.js';

const version = (
  observationId: string,
  sourceUpdatedAt: string | null,
  observedAt: string,
) => ({ observationId, sourceUpdatedAt, observedAt });

describe('replacesProfile', () => {
  it('orders by source update time when both reads report one', () => {
    const current = version(
      'a',
      '2026-09-01T10:00:00Z',
      '2026-09-29T10:00:00Z',
    );

    expect(
      replacesProfile(
        version('b', '2026-09-02T10:00:00Z', '2026-09-28T10:00:00Z'),
        current,
      ),
    ).toBe(true);
    expect(
      replacesProfile(
        version('c', '2026-09-01T10:00:00Z', '2026-09-30T10:00:00Z'),
        current,
      ),
    ).toBe(false);
  });

  it('falls back to the later read without comparing clocks', () => {
    const current = version('a', null, '2026-09-29T10:00:00Z');

    expect(
      replacesProfile(
        version('b', '2026-01-01T00:00:00Z', '2026-09-29T10:00:01Z'),
        current,
      ),
    ).toBe(true);
    expect(
      replacesProfile(version('c', null, '2026-09-29T09:00:00Z'), current),
    ).toBe(false);
  });

  it('treats the same observation as unchanged', () => {
    const current = version('a', null, '2026-09-29T10:00:00Z');

    expect(replacesProfile(current, current)).toBe(false);
  });
});
