import { useSyncExternalStore } from 'react';

/**
 * Returns the current time, refreshed every `intervalMs` while `active`. Values are rounded
 * to the interval so renders only happen when the displayed time changes.
 */
export function useNow(intervalMs: number, active = true) {
  return useSyncExternalStore(
    (notify) => {
      const timer = active ? window.setInterval(notify, intervalMs) : undefined;

      return () => window.clearInterval(timer);
    },
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
  );
}
