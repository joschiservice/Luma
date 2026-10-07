import { createContext, useContext } from 'react';

import { workspaceDateValue } from '../../lib/timezone';

export const WorkspaceTimezone = createContext('UTC');

/**
 * Formats a UTC timestamp in the workspace display timezone and retains the exact instant.
 * `precision="day"` shows only the workspace date, for facts such as when a customer joined.
 */
export function WorkspaceDate({
  value,
  precision = 'time',
}: {
  value: string;
  precision?: 'time' | 'day';
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const date = new Date(value);

  return (
    <time dateTime={value} title={value}>
      {precision === 'day'
        ? workspaceDateValue(date, timeZone)
        : `${workspaceDateValue(date, timeZone, true).replace('T', ' ')} ${timeZone}`}
    </time>
  );
}
