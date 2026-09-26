import { createContext, useContext } from 'react';

import { workspaceDateValue } from '../../lib/timezone';

export const WorkspaceTimezone = createContext('UTC');

/** Formats a UTC timestamp in the workspace display timezone and retains the exact instant. */
export function WorkspaceDate({ value }: { value: string }) {
  const timeZone = useContext(WorkspaceTimezone);
  const date = new Date(value);

  return (
    <time dateTime={value} title={value}>
      {`${workspaceDateValue(date, timeZone, true).replace('T', ' ')} ${timeZone}`}
    </time>
  );
}
