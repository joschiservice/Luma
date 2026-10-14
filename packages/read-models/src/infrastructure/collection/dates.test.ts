import { describe, expect, it } from 'vitest';

import {
  formatLocalDate,
  localDate,
  parseInstant,
  parseLocalDate,
  periodStart,
  shiftLocalDate,
  startOfLocalDay,
} from './dates.js';

describe('local calendar dates', () => {
  it('starts days at local midnight on both sides of daylight-saving changes', () => {
    // Berlin moves to summer time on 2026-03-29 and back on 2026-10-25.
    expect(
      startOfLocalDay({ year: 2026, month: 3, day: 29 }, 'Europe/Berlin'),
    ).toEqual(new Date('2026-03-28T23:00:00Z'));
    expect(
      startOfLocalDay({ year: 2026, month: 3, day: 30 }, 'Europe/Berlin'),
    ).toEqual(new Date('2026-03-29T22:00:00Z'));
    expect(
      startOfLocalDay({ year: 2026, month: 10, day: 25 }, 'Europe/Berlin'),
    ).toEqual(new Date('2026-10-24T22:00:00Z'));
    expect(
      startOfLocalDay({ year: 2026, month: 10, day: 26 }, 'Europe/Berlin'),
    ).toEqual(new Date('2026-10-25T23:00:00Z'));
    expect(
      startOfLocalDay({ year: 2026, month: 3, day: 8 }, 'America/New_York'),
    ).toEqual(new Date('2026-03-08T05:00:00Z'));
  });

  it('starts a day at the transition when its midnight does not exist', () => {
    // Santiago skips from 00:00 to 01:00 on 2026-09-06.
    const start = startOfLocalDay(
      { year: 2026, month: 9, day: 6 },
      'America/Santiago',
    );

    expect(formatLocalDate(localDate(start, 'America/Santiago'))).toBe(
      '2026-09-06',
    );
    expect(
      localDate(new Date(start.getTime() - 1), 'America/Santiago').day,
    ).toBe(5);
  });

  it('reads the local day of an instant', () => {
    expect(
      localDate(new Date('2026-10-12T22:30:00Z'), 'Europe/Berlin'),
    ).toEqual({ year: 2026, month: 10, day: 13 });
    expect(localDate(new Date('2026-10-12T22:30:00Z'), 'UTC')).toEqual({
      year: 2026,
      month: 10,
      day: 12,
    });
  });

  it('shifts by days, weeks and clamped months', () => {
    const date = { year: 2026, month: 3, day: 31 };

    expect(formatLocalDate(shiftLocalDate(date, -1, 'month'))).toBe(
      '2026-02-28',
    );
    expect(formatLocalDate(shiftLocalDate(date, 1, 'week'))).toBe('2026-04-07');
    expect(formatLocalDate(shiftLocalDate(date, -31, 'day'))).toBe(
      '2026-02-28',
    );
    expect(formatLocalDate(shiftLocalDate(date, -15, 'month'))).toBe(
      '2024-12-31',
    );
  });

  it('finds the start of ISO weeks and months', () => {
    expect(
      formatLocalDate(periodStart({ year: 2026, month: 10, day: 18 }, 'week')),
    ).toBe('2026-10-12');
    expect(
      formatLocalDate(periodStart({ year: 2026, month: 10, day: 12 }, 'week')),
    ).toBe('2026-10-12');
    expect(
      formatLocalDate(periodStart({ year: 2026, month: 10, day: 18 }, 'month')),
    ).toBe('2026-10-01');
  });

  it('parses only real days and instants with offsets', () => {
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2028-02-29')).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(parseInstant('2026-10-13T10:00:00')).toBeNull();
    expect(parseInstant('2026-10-13T10:00:00+02:00')).toEqual(
      new Date('2026-10-13T08:00:00Z'),
    );
  });
});
