import { useSyncExternalStore } from 'react';

const key = 'luma-display-timezone';
const changed = 'luma-display-timezone-change';
let volatile: string | null = null;
let storageUnavailable = false;

function valid(value: string | null): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}

function read() {
  if (storageUnavailable) return volatile;
  try {
    const value = localStorage.getItem(key);

    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(changed, listener);

  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(changed, listener);
  };
}

/** Reads this device's optional display zone; server rendering and absent preferences follow the workspace. */
export function useDisplayTimezonePreference() {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Saves a validated display zone for this device, or restores the workspace default. */
export function setDisplayTimezonePreference(value: string | null) {
  if (value !== null && !valid(value))
    throw new RangeError('Invalid time zone');
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    volatile = value;
    storageUnavailable = true;
  }
  window.dispatchEvent(new Event(changed));
}
