import { formatDateTime } from '@luma/i18n/format';
import { createContext, useContext } from 'react';

export const WorkspaceTimezone = createContext('UTC');

const dateFields = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
} satisfies Intl.DateTimeFormatOptions;

const timeFields = {
  time: { hour: '2-digit', minute: '2-digit' },
  second: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/**
 * Joins the date and the time with a space. Browsers disagree on the joiner when both are
 * formatted together (“9 Oct 2026, 07:25” or “9 Oct 2026 at 07:25”), so each part is formatted
 * on its own.
 */
function dateAndTime(
  value: Date | string,
  timeZone: string,
  time: Intl.DateTimeFormatOptions,
) {
  return `${formatDateTime(value, { ...dateFields, timeZone })} ${formatDateTime(value, { ...time, timeZone })}`;
}

/**
 * Formats a UTC timestamp in the workspace display timezone and the interface language, such as
 * "8 Oct 2026 14:05". The zone is named to make deadlines and daylight saving changes explicit. `day` shows only the
 * workspace date and `second` adds seconds for audit detail.
 */
export function formatWorkspaceDateTime(
  value: Date | string,
  timeZone: string,
  precision: 'day' | keyof typeof timeFields = 'time',
) {
  return precision === 'day'
    ? formatDateTime(value, { ...dateFields, timeZone })
    : dateAndTime(value, timeZone, {
        ...timeFields[precision],
        timeZoneName: 'short',
      });
}

/** Formats a time of day in the workspace zone, including its current zone abbreviation. */
export function formatWorkspaceTime(value: Date | string, timeZone: string) {
  return formatDateTime(value, {
    ...timeFields.time,
    timeZone,
    timeZoneName: 'short',
  });
}

/** Formats the exact moment with seconds and the zone name, such as "8 Oct 2026 14:05:32 CEST". */
export function formatWorkspaceInstant(value: Date | string, timeZone: string) {
  return dateAndTime(value, timeZone, {
    ...timeFields.second,
    timeZoneName: 'short',
  });
}

/**
 * Shows a UTC timestamp in workspace time with the zone name, such as "8 Oct 2026 14:05", and
 * names the exact moment with its zone in the `title`. `precision="day"` shows only the workspace
 * date, for facts such as when a customer joined.
 */
export function WorkspaceDate({
  value,
  precision = 'time',
}: {
  value: string;
  precision?: 'time' | 'day';
}) {
  const timeZone = useContext(WorkspaceTimezone);

  return (
    <time dateTime={value} title={formatWorkspaceInstant(value, timeZone)}>
      {formatWorkspaceDateTime(value, timeZone, precision)}
    </time>
  );
}
