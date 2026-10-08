const reportIntervalMs = 30_000;
const activityLifetimeMs = 60_000;

/**
 * Records trusted browser input and reports it once on a later private request. Passive
 * refreshes cannot manufacture activity; stale input is discarded and reports are throttled.
 */
export function createStaffActivityTracker(now: () => number = Date.now) {
  let pendingAt: number | undefined;
  let reportedAt = Number.NEGATIVE_INFINITY;

  return {
    record(event: Pick<Event, 'isTrusted'>) {
      if (event.isTrusted) pendingAt = now();
    },
    consume() {
      const current = now();
      if (pendingAt === undefined) return false;
      if (current - pendingAt > activityLifetimeMs) {
        pendingAt = undefined;

        return false;
      }
      if (current - reportedAt < reportIntervalMs) return false;
      pendingAt = undefined;
      reportedAt = current;

      return true;
    },
    reset() {
      pendingAt = undefined;
      reportedAt = Number.NEGATIVE_INFINITY;
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
