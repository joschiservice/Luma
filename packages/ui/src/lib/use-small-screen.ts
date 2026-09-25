import { useEffect, useState } from 'react';

/** Tracks the shared mobile breakpoint for responsive overlays. */
export function useSmallScreen() {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setSmall(query.matches);
    update();
    query.addEventListener('change', update);

    return () => query.removeEventListener('change', update);
  }, []);

  return small;
}
