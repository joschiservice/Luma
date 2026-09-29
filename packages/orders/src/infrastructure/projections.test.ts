import { describe, expect, it } from 'vitest';

import { supersedes } from './projections.js';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';

function snapshot(
  observationId: string,
  observedAt: string,
  sourceUpdatedAt: string | null = null,
) {
  return { observationId, observedAt, sourceUpdatedAt };
}

describe('supersedes', () => {
  it('orders snapshots with source update times by those times only', () => {
    const current = snapshot(a, '2026-09-20T00:00:00Z', '2026-09-18T00:00:00Z');

    expect(
      supersedes(
        snapshot(b, '2026-09-19T00:00:00Z', '2026-09-18T01:00:00Z'),
        current,
      ),
    ).toBe(true);
    expect(
      supersedes(
        snapshot(b, '2026-09-21T00:00:00Z', '2026-09-18T00:00:00Z'),
        current,
      ),
    ).toBe(false);
    expect(
      supersedes(
        snapshot(b, '2026-09-21T00:00:00Z', '2026-09-17T00:00:00Z'),
        current,
      ),
    ).toBe(false);
  });

  it('advances untimed sources to the later read and ignores late older reads', () => {
    const first = snapshot(a, '2026-09-20T00:00:00Z');
    const later = snapshot(b, '2026-09-20T00:05:00Z');

    expect(supersedes(later, first)).toBe(true);
    expect(supersedes(first, later)).toBe(false);
  });

  it('breaks equal untimed observation times by observation ID in either arrival order', () => {
    const low = snapshot(a, '2026-09-20T00:00:00Z');
    const high = snapshot(b, '2026-09-20T00:00:00.000+00:00');

    expect(supersedes(high, low)).toBe(true);
    expect(supersedes(low, high)).toBe(false);
  });

  it('orders mixed snapshots by observation time and retains equal times', () => {
    const timed = snapshot(a, '2026-09-20T00:00:00Z', '2026-09-25T00:00:00Z');

    expect(supersedes(snapshot(b, '2026-09-20T00:01:00Z'), timed)).toBe(true);
    expect(supersedes(snapshot(b, '2026-09-19T23:59:00Z'), timed)).toBe(false);
    expect(supersedes(snapshot(b, '2026-09-20T00:00:00Z'), timed)).toBe(false);

    const untimed = snapshot(b, '2026-09-20T00:00:00Z');

    expect(
      supersedes(
        snapshot(a, '2026-09-20T00:01:00Z', '2026-01-01T00:00:00Z'),
        untimed,
      ),
    ).toBe(true);
    expect(
      supersedes(
        snapshot(a, '2026-09-19T23:59:00Z', '2026-12-31T00:00:00Z'),
        untimed,
      ),
    ).toBe(false);
    expect(
      supersedes(
        snapshot(a, '2026-09-20T00:00:00Z', '2026-12-31T00:00:00Z'),
        untimed,
      ),
    ).toBe(false);
  });

  it('lets a re-normalized copy of the current observation replace it', () => {
    const current = snapshot(a, '2026-09-20T00:00:00Z', '2026-09-18T00:00:00Z');

    expect(supersedes({ ...current }, current)).toBe(true);
  });

  it('settles every arrival order of the same untimed reads on one snapshot', () => {
    const reads = [
      snapshot(a, '2026-09-20T00:00:00Z'),
      snapshot(b, '2026-09-20T00:00:00Z'),
      snapshot('00000000-0000-4000-8000-000000000001', '2026-09-20T00:10:00Z'),
      snapshot('00000000-0000-4000-8000-000000000002', '2026-09-19T00:00:00Z'),
    ];
    const settle = (order: typeof reads) =>
      order.reduce((current, next) =>
        supersedes(next, current) ? next : current,
      );

    for (let i = 0; i < reads.length; i++) {
      const rotated = [...reads.slice(i), ...reads.slice(0, i)];

      expect(settle(rotated)).toBe(reads[2]);
      expect(settle([...rotated].reverse())).toBe(reads[2]);
    }
  });
});
