import { describe, expect, it } from 'vitest';

import { rankedGroupResults } from './list-groups.js';

const a = '5f0f4c2e-8d4b-4a51-9c1e-3f2a6b7c8d90';
const b = '0b6f1f43-6a55-4c2c-a1d1-7a1c2b3d4e5f';

describe('ranked groups', () => {
  it('give a cursor only to groups with more rows than their head', () => {
    const written: unknown[] = [];
    const result = rankedGroupResults(
      [
        {
          key: 'active',
          count: 3,
          head: [
            { id: a, rank: false, keys: ['1', 'apron'] },
            { id: b, rank: true, keys: null },
          ],
        },
        { key: null, count: 1, head: [{ id: a, rank: false, keys: ['2'] }] },
      ],
      (key, last) => {
        written.push([key, last]);

        return `cursor-${String(key)}`;
      },
    );

    expect(result).toEqual({
      groups: [
        {
          key: 'active',
          count: 3,
          complete: true,
          itemIds: [a, b],
          nextCursor: 'cursor-active',
          sums: [],
        },
        {
          key: null,
          count: 1,
          complete: true,
          itemIds: [a],
          nextCursor: null,
          sums: [],
        },
      ],
      truncated: false,
    });
    expect(written).toEqual([['active', { rank: 1, keys: null, ids: [b] }]]);
  });

  it('return at most 50 groups and report that more exist', () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      key: `g${index}`,
      count: 1,
      head: [{ id: a, rank: false, keys: ['x'] }],
    }));
    const result = rankedGroupResults(rows, () => 'cursor');

    expect(result.groups).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});
