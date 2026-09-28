import { useSyncExternalStore } from 'react';

const storageKey = 'luma-sidebar';
const changeEvent = 'luma-sidebar-change';

/** Reads whether the workspace sidebar is collapsed to its icon rail. */
export function readSidebarCollapsed() {
  try {
    return localStorage.getItem(storageKey) === 'collapsed';
  } catch {
    return false;
  }
}

/** Collapses or expands the sidebar on this device and notifies subscribers. */
export function setSidebarCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(storageKey, 'collapsed');
    else localStorage.removeItem(storageKey);
  } catch {
    // The layout still changes for this page when storage is unavailable.
  }
  window.dispatchEvent(new Event(changeEvent));
}

function subscribe(callback: () => void) {
  window.addEventListener(changeEvent, callback);
  window.addEventListener('storage', callback);

  return () => {
    window.removeEventListener(changeEvent, callback);
    window.removeEventListener('storage', callback);
  };
}

/** Returns whether the sidebar is collapsed and re-renders when it changes. */
export function useSidebarCollapsed() {
  return useSyncExternalStore(subscribe, readSidebarCollapsed, () => false);
}
