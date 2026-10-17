import { useSyncExternalStore } from 'react';

const tickMs = 15_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, tickMs);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };
}

function snapshot() {
  // Without subscribers the clock is not ticking; refresh a stale reading for the first render.
  if (!timer && Date.now() - now >= tickMs) now = Date.now();

  return now;
}

/**
 * Returns the current time, shared by every caller and advanced every 15 seconds while any
 * component reads it, so deadlines count down between reads. Read it in the small components
 * that show a time, not at the top of a page, so each tick re-renders only those cells.
 */
export function useNow() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
