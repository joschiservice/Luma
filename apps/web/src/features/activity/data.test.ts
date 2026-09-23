import { describe, expect, it } from 'vitest';

import { activityRange, parseActivityFilters } from './data';

describe('activity URL state', () => {
  it('preserves supported filters and position', () => {
    const value = {
      from: '2026-09-01',
      to: '2026-09-22',
      q: 'Order 1042',
      type: 'verification',
      outcome: 'uncertain',
      system: 'jtl-cloud',
      cursor: 'abc',
      event: 'event',
    };
    expect(parseActivityFilters(value)).toMatchObject(value);
  });
  it('discards invalid dates, overlong ranges and unsupported filters', () => {
    expect(
      parseActivityFilters({
        from: '2026-02-30',
        type: 'payload',
        outcome: 'success',
        connectionId: 'secret',
      }),
    ).toMatchObject({
      from: undefined,
      type: undefined,
      outcome: undefined,
      connectionId: undefined,
    });
    expect(
      parseActivityFilters({ from: '2020-01-01', to: '2026-09-22' }).from,
    ).toBeUndefined();
    expect(parseActivityFilters({ q: 'x'.repeat(201) }).q).toHaveLength(200);
  });
  it('resolves default dates in UTC', () => {
    expect(activityRange({}, new Date('2026-09-22T00:00:00Z'))).toEqual({
      from: '2026-08-24',
      to: '2026-09-22',
    });
  });
});
