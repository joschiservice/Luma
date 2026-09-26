/** Returns an ISO calendar date or local date-time in an IANA timezone. */
export function workspaceDateValue(
  value: Date,
  timeZone: string,
  includeTime = false,
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;

  return includeTime
    ? `${day}T${part('hour')}:${part('minute')}:${part('second')}`
    : day;
}

/** Converts a workspace calendar date or local date-time to UTC, rejecting skipped clock times. */
export function workspaceInstant(value: string, timeZone: string): string {
  const calendarDay = value.length === 10;
  const local = calendarDay ? `${value}T00:00:00` : value;
  const target = Date.parse(`${local}Z`);
  if (!Number.isFinite(target))
    throw new Error('Choose a valid date and time.');
  const milliseconds = ((target % 1000) + 1000) % 1000;
  let guess = target;
  const candidates: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = Date.parse(
      `${workspaceDateValue(new Date(guess), timeZone, true)}Z`,
    );
    candidates.push(guess);
    const offset = target - (represented + milliseconds);
    if (offset === 0) return new Date(guess).toISOString();
    guess += offset;
  }
  if (calendarDay) {
    // Midnight transitions can skip the first hour without skipping the calendar day.
    const valid = candidates.filter(
      (instant) => workspaceDateValue(new Date(instant), timeZone) === value,
    );
    if (valid.length) {
      let end = Math.min(...valid);
      let start = end - 86400000;
      while (end - start > 1) {
        const middle = Math.floor((start + end) / 2);
        if (workspaceDateValue(new Date(middle), timeZone) < value)
          start = middle;
        else end = middle;
      }

      return new Date(end).toISOString();
    }
  }
  throw new Error(
    'This local time does not exist because the clocks change. Choose another time.',
  );
}

/** Advances a calendar date without applying a browser-local offset. */
export function nextCalendarDay(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
}
