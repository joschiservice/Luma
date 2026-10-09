import { useEffect, useState } from 'react';

/** How long a read may run before a view says it is still updating. */
export const slowRequestMs = 10_000;

/**
 * Reports whether `active` has stayed true for `delay` milliseconds. Live views refresh often,
 * so quick background reads stay silent and only a read that takes longer than expected shows
 * progress. Controls stay usable either way.
 */
export function useSlowRequest(active: boolean, delay = slowRequestMs) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSlow(true), delay);

    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [active, delay]);

  return active && slow;
}
