import { describe, expect, it } from 'vitest';

import { collectionCursorContext } from './cursor.js';

const relative = {
  timeZone: 'Europe/Berlin',
  where: {
    match: 'all',
    conditions: [
      { field: 'placed', op: 'within_last', value: { amount: 7, unit: 'day' } },
    ],
  },
};

describe('collection cursors', () => {
  it('end a relative-date query at the reader’s midnight', () => {
    const evening = new Date('2026-10-13T21:59:00Z');
    const night = new Date('2026-10-13T22:01:00Z');
    expect(collectionCursorContext('x', 't', relative, evening)).not.toBe(
      collectionCursorContext('x', 't', relative, night),
    );
  });

  it('keep other queries valid across days', () => {
    const fixed = { timeZone: 'UTC', where: { match: 'all', conditions: [] } };
    expect(
      collectionCursorContext(
        'x',
        't',
        fixed,
        new Date('2026-10-13T10:00:00Z'),
      ),
    ).toBe(
      collectionCursorContext(
        'x',
        't',
        fixed,
        new Date('2026-10-14T10:00:00Z'),
      ),
    );
  });
});
