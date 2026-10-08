import { formatDateTime } from '@luma/i18n/format';
import { createContext, useContext } from 'react';

export const WorkspaceTimezone = createContext('UTC');

/**
 * Formats a UTC timestamp in the workspace display timezone and the interface language, such as
 * "8 Oct 2026, 14:05 CEST", and keeps the exact instant in the `title`. `precision="day"` shows
 * only the workspace date, for facts such as when a customer joined.
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
    <time dateTime={value} title={value}>
      {precision === 'day'
        ? formatDateTime(value, { dateStyle: 'medium', timeZone })
        : formatDateTime(value, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
            timeZoneName: 'short',
          })}
    </time>
  );
}
