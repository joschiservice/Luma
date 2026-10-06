/** An inclusive range of ISO calendar dates. Either end may be open. */
export interface CalendarRange {
  from?: string | undefined;
  to?: string | undefined;
}

/** Moves an ISO calendar date by whole days without applying a browser-local offset. */
export function shiftCalendarDay(value: string, days: number) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

/** Quick ranges ending today, in the caller's calendar. */
export function calendarPresets(today: string) {
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: shiftCalendarDay(today, -6), to: today },
    { label: 'Last 30 days', from: shiftCalendarDay(today, -29), to: today },
  ];
}

const days = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const shortDays = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const format = (value: string) => days.format(new Date(`${value}T00:00:00Z`));

/**
 * Names a calendar range for a filter chip: a preset name such as "Last 7 days" when it matches
 * one, otherwise dates such as "Oct 1 – Oct 6, 2026", "From Oct 1, 2026" or "Through Oct 6, 2026".
 */
export function describeCalendarRange(range: CalendarRange, today: string) {
  const { from, to } = range;
  const preset = calendarPresets(today).find(
    (item) => item.from === from && item.to === to,
  );
  if (preset) return preset.label;
  if (from && to) {
    if (from === to) return format(from);

    return from.slice(0, 4) === to.slice(0, 4)
      ? `${shortDays.format(new Date(`${from}T00:00:00Z`))} – ${format(to)}`
      : `${format(from)} – ${format(to)}`;
  }
  if (from) return `From ${format(from)}`;
  if (to) return `Through ${format(to)}`;

  return 'Any time';
}

/**
 * Explains why a calendar range cannot be applied, or returns undefined when it is valid. Both
 * ends are optional unless `required`; `maxDays` limits the inclusive length.
 */
export function calendarRangeError(
  range: CalendarRange,
  {
    required = false,
    maxDays,
  }: { required?: boolean; maxDays?: number | undefined } = {},
) {
  const { from, to } = range;
  if (required && (!from || !to)) return 'Choose a start and an end date.';
  if (!from && !to) return 'Choose a start date, an end date or both.';
  if (from && to && from > to)
    return 'Choose an end date on or after the start.';
  if (
    maxDays &&
    from &&
    to &&
    (Date.parse(to) - Date.parse(from)) / 86400000 >= maxDays
  )
    return `Choose a range of at most ${maxDays} days.`;

  return undefined;
}
