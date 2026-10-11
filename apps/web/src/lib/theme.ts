import { useSyncExternalStore } from 'react';

/** The reader's chosen appearance. `system` follows the operating system setting. */
export type ThemePreference = 'system' | 'light' | 'dark';

const storageKey = 'luma-theme';
const changeEvent = 'luma-theme-change';

/**
 * Inline script for the document head. It applies the stored preference before the
 * first paint so the page does not flash the wrong theme.
 */
export const themeBootScript = `(()=>{try{var p=localStorage.getItem('${storageKey}');var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

/** Reads the stored preference, falling back to `system` when storage is unavailable. */
function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);

    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the effective theme to the document element so portals inherit it. */
function applyTheme(preference = readThemePreference()) {
  const dark =
    preference === 'dark' ||
    (preference === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Stores and applies a preference, then notifies subscribed components. */
export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    // The preference still applies for this page when storage is unavailable.
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(changeEvent));
}

/**
 * Keeps the document theme in sync with system changes and preference changes made in
 * other tabs. Returns a cleanup function.
 */
export function watchTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => applyTheme();
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) update();
  };
  update();
  media.addEventListener('change', update);
  window.addEventListener('storage', onStorage);

  return () => {
    media.removeEventListener('change', update);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribe(callback: () => void) {
  window.addEventListener(changeEvent, callback);
  window.addEventListener('storage', callback);

  return () => {
    window.removeEventListener(changeEvent, callback);
    window.removeEventListener('storage', callback);
  };
}

/** Returns the stored preference and re-renders when it changes. */
export function useThemePreference() {
  return useSyncExternalStore(
    subscribe,
    readThemePreference,
    () => 'system' as const,
  );
}
