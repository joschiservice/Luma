import { formatCalendarDate, formattingLocale } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

/** An inclusive range of ISO calendar dates. Either end may be open. */
export interface CalendarRange {
  from?: string | undefined;
  to?: string | undefined;
}

/** Moves an ISO calendar date by whole days without applying a browser-local offset. */
function shiftCalendarDay(value: string, days: number) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

/** Identifies a quick range, so callers can name the same range as a preset does. */
export type CalendarPresetId = 'today' | 'last_7_days' | 'last_30_days';

const presetLabels = {
  today: m.ui_date_range_today,
  last_7_days: m.ui_date_range_last_7_days,
  last_30_days: m.ui_date_range_last_30_days,
} satisfies Record<CalendarPresetId, () => string>;

/** Names a quick range in the interface language, such as "Last 30 days". */
function calendarPresetLabel(id: CalendarPresetId) {
  return presetLabels[id]();
}

/** Quick ranges ending today, in the caller's calendar, with names in the interface language. */
export function calendarPresets(today: string) {
  return [
    {
      id: 'today',
      label: calendarPresetLabel('today'),
      from: today,
      to: today,
    },
    {
      id: 'last_7_days',
      label: calendarPresetLabel('last_7_days'),
      from: shiftCalendarDay(today, -6),
      to: today,
    },
    {
      id: 'last_30_days',
      label: calendarPresetLabel('last_30_days'),
      from: shiftCalendarDay(today, -29),
      to: today,
    },
  ] satisfies {
    id: CalendarPresetId;
    label: string;
    from: string;
    to: string;
  }[];
}

const dayOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
} satisfies Intl.DateTimeFormatOptions;

const calendarDate = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * Names a calendar range for a filter chip in the interface language: a preset name such as
 * "Last 7 days" when it matches one, otherwise dates such as "1 Sept – 6 Oct 2026",
 * "From 1 Oct 2026" or "Through 6 Oct 2026".
 */
export function describeCalendarRange(range: CalendarRange, today: string) {
  const { from, to } = range;
  const preset = calendarPresets(today).find(
    (item) => item.from === from && item.to === to,
  );
  if (preset) return preset.label;
  if (from && to) {
    if (from === to) return formatCalendarDate(from, dayOptions);

    // Intl pads the range dash with thin spaces; plain spaces keep chip names easy to match.
    return new Intl.DateTimeFormat(formattingLocale(), dayOptions)
      .formatRange(calendarDate(from), calendarDate(to))
      .replace(/\u2009/g, ' ');
  }
  if (from)
    return m.ui_date_range_from_date({
      date: formatCalendarDate(from, dayOptions),
    });
  if (to)
    return m.ui_date_range_through_date({
      date: formatCalendarDate(to, dayOptions),
    });

  return m.ui_date_range_any_time();
}

/**
 * Explains in the interface language why a calendar range cannot be applied, or returns undefined when it is valid. Both
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
  if (required && (!from || !to)) return m.ui_date_range_error_required();
  if (!from && !to) return m.ui_date_range_error_empty();
  if (from && to && from > to) return m.ui_date_range_error_order();
  if (
    maxDays &&
    from &&
    to &&
    (Date.parse(to) - Date.parse(from)) / 86400000 >= maxDays
  )
    return m.ui_date_range_error_too_long({ maxDays });

  return undefined;
}
