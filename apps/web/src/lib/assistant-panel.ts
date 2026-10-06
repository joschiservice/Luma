import { useSyncExternalStore } from 'react';

const storageKey = 'luma-assistant';
const changeEvent = 'luma-assistant-change';

/** Reads whether the Ask Luma panel is open on this device. */
export function readAssistantOpen() {
  try {
    return localStorage.getItem(storageKey) === 'open';
  } catch {
    return false;
  }
}

/**
 * Opens or closes the Ask Luma panel on this device and notifies subscribers. Only the
 * open state is stored; conversations stay in memory.
 */
export function setAssistantOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(storageKey, 'open');
    else localStorage.removeItem(storageKey);
  } catch {
    // The panel still opens for this page when storage is unavailable.
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

/** Returns whether the Ask Luma panel is open and re-renders when it changes. */
export function useAssistantOpen() {
  return useSyncExternalStore(subscribe, readAssistantOpen, () => false);
}

const draftEvent = 'luma-assistant-draft';

/** Opens the panel with `question` in the composer, ready to send. */
export function askLuma(question = '') {
  setAssistantOpen(true);
  if (question)
    window.dispatchEvent(new CustomEvent(draftEvent, { detail: question }));
}

/** Calls `onDraft` with questions handed to the panel from elsewhere, such as the command menu. */
export function subscribeAssistantDraft(onDraft: (question: string) => void) {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === 'string')
      onDraft(event.detail);
  };
  window.addEventListener(draftEvent, listener);

  return () => window.removeEventListener(draftEvent, listener);
}
