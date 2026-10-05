import { useCallback, useSyncExternalStore } from 'react';

const changeEvent = 'simulator-location';

function subscribe(notify: () => void) {
  window.addEventListener('popstate', notify);
  window.addEventListener(changeEvent, notify);

  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener(changeEvent, notify);
  };
}

/**
 * Keeps one value in the page address so a reload or shared link restores the view. Changes
 * replace the current history entry. Returns `fallback` while the parameter is absent.
 */
export function useSearchParam<Value extends string>(
  name: string,
  fallback: Value,
  accept: (value: string) => value is Value,
) {
  const raw = useSyncExternalStore(subscribe, () =>
    new URLSearchParams(window.location.search).get(name),
  );
  const value = raw !== null && accept(raw) ? raw : fallback;
  const setValue = useCallback(
    (next: Value | null) => {
      const url = new URL(window.location.href);
      if (next === null) url.searchParams.delete(name);
      else url.searchParams.set(name, next);
      window.history.replaceState(window.history.state, '', url);
      window.dispatchEvent(new Event(changeEvent));
    },
    [name],
  );

  return [value, setValue] as const;
}
