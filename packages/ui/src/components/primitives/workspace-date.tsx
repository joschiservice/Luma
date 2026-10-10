import { formatDateTime } from '@luma/i18n/format';
import { createContext, useContext } from 'react';

export const WorkspaceTimezone = createContext('UTC');

const precisions = {
  day: { dateStyle: 'medium' },
  time: {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  second: { dateStyle: 'medium', timeStyle: 'medium' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/**
 * Formats a UTC timestamp in the workspace display timezone and the interface language, such as
 * "8 Oct 2026, 14:05". The zone isn't named, because every time in a workspace shares it;
 * `formatWorkspaceInstant` names it where the exact moment matters. `day` shows only the
 * workspace date and `second` adds seconds for audit detail.
 */
export function formatWorkspaceDateTime(
  value: Date | string,
  timeZone: string,
  precision: keyof typeof precisions = 'time',
) {
  return formatDateTime(value, { ...precisions[precision], timeZone });
}

/** Formats the exact moment with seconds and the zone name, such as "8 Oct 2026, 14:05:32 CEST". */
export function formatWorkspaceInstant(value: Date | string, timeZone: string) {
  return formatDateTime(value, {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone,
  });
}

/**
 * Shows a UTC timestamp in workspace time without the zone name, such as "8 Oct 2026, 14:05", and
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
