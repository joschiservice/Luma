/** Reports whether a key event targets a text field, where single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="combobox"], [contenteditable="true"]',
    ) !== null
  );
}

/** Reports whether the platform uses the Command key for shortcuts. */
export function usesCommandKey() {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}
