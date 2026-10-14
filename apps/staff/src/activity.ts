const reportIntervalMs = 30_000;
const activityLifetimeMs = 60_000;

/**
 * Records trusted browser input and reports it once per regional API on a later private request. Passive
 * refreshes cannot manufacture activity; stale input is discarded and reports are throttled.
 */
export function createStaffActivityTracker(now: () => number = Date.now) {
  let pendingAt: number | undefined;
  let sequence = 0;
  const reports = new Map<string, { at: number; sequence: number }>();

  return {
    record(event: Pick<Event, 'isTrusted'>) {
      if (event.isTrusted) {
        pendingAt = now();
        sequence++;
      }
    },
    consume(scope = 'default') {
      const current = now();
      if (pendingAt === undefined) return false;
      if (current - pendingAt > activityLifetimeMs) {
        pendingAt = undefined;

        return false;
      }
      const previous = reports.get(scope);
      if (
        previous?.sequence === sequence ||
        (previous && current - previous.at < reportIntervalMs)
      )
        return false;
      reports.set(scope, { at: current, sequence });

      return true;
    },
    reset() {
      pendingAt = undefined;
      sequence = 0;
      reports.clear();
    },
  };
}

export const staffActivity = createStaffActivityTracker();

/** Tracks deliberate keyboard, pointer and scrolling input for this browser application. */
export function trackStaffActivity(target: Window) {
  const options = { capture: true, passive: true };
  const record = (event: Event) => staffActivity.record(event);
  const events = ['keydown', 'pointerdown', 'wheel'] as const;
  for (const event of events) target.addEventListener(event, record, options);

  return () => {
    for (const event of events)
      target.removeEventListener(event, record, options);
    staffActivity.reset();
  };
}
