// Calendar rules for list conditions. They mirror the collection SQL date rules in
// `@luma/read-models` (which procurement cannot import), so day values, `today` and relative
// periods mean the same on every list.

/** A calendar day without a time zone; `month` is 1–12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** A calendar unit for relative periods and date groups. */
export type CalendarUnit = 'day' | 'week' | 'month';

const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }

  return format;
}

/** Wall-clock fields of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string) {
  const fields = new Map<string, number>();
  for (const part of formatter(timeZone).formatToParts(new Date(instant)))
    if (part.type !== 'literal') fields.set(part.type, Number(part.value));
  const field = (name: string) => fields.get(name) ?? 0;

  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour') % 24,
    minute: field('minute'),
    second: field('second'),
  };
}

/** Milliseconds the zone's wall clock is ahead of UTC at `instant`. */
function offset(instant: number, timeZone: string) {
  const whole = Math.floor(instant / 1000) * 1000;
  const wall = wallClock(whole, timeZone);

  return (
    Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    ) - whole
  );
}

function sameDay(a: LocalDate, b: LocalDate) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** The calendar day `instant` falls on in `timeZone`. Throws a RangeError for unknown zones. */
export function localDate(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = wallClock(instant.getTime(), timeZone);

  return { year, month, day };
}

/**
 * The first instant of `date` in `timeZone`. On days whose midnight falls into a daylight-saving
 * gap, the day starts at the transition.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day);
  // The offset before or after a nearby transition gives every candidate start.
  const candidates = [
    wall - offset(wall - dayMs, timeZone),
    wall - offset(wall + dayMs, timeZone),
  ]
    .filter((instant) => sameDay(localDate(new Date(instant), timeZone), date))
    .sort((a, b) => a - b);

  return new Date(candidates[0] ?? wall - offset(wall, timeZone));
}

/** Shifts a calendar day by whole days, weeks or months; month ends clamp to the shorter month. */
export function shiftLocalDate(
  date: LocalDate,
  amount: number,
  unit: CalendarUnit,
): LocalDate {
  if (unit === 'month') {
    const months = date.year * 12 + date.month - 1 + amount;
    const year = Math.floor(months / 12);
    const month = (months % 12) + 1;
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();

    return { year, month, day: Math.min(date.day, length) };
  }
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day) +
      amount * (unit === 'week' ? 7 : 1) * dayMs,
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Formats a calendar day as `YYYY-MM-DD`. */
export function formatLocalDate(date: LocalDate) {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Parses `YYYY-MM-DD`, or returns null when the text is not a real calendar day. */
export function parseLocalDate(text: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));

  return check.getUTCFullYear() === date.year &&
    check.getUTCMonth() + 1 === date.month &&
    check.getUTCDate() === date.day
    ? date
    : null;
}

/** Parses an ISO 8601 instant with an explicit offset or `Z`, or returns null. */
export function parseInstant(text: string): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      text,
    )
  )
    return null;
  const instant = new Date(text);

  return Number.isNaN(instant.getTime()) ? null : instant;
}
