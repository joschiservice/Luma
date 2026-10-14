import { type RefObject, useEffect, useRef, useState } from 'react';

/** A list command bound to a single key. */
export type ListShortcut =
  | 'next'
  | 'previous'
  | 'open'
  | 'preview'
  | 'toggle-selection'
  | 'extend-selection'
  | 'escape'
  | 'search'
  | 'filter'
  | 'help';

interface KeyPress {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Maps a key press to a list command: J/K or the arrow keys move, Enter opens, Space previews,
 * X selects and Shift+X extends the selection, Escape clears, `/` searches, F filters and `?`
 * shows help. Presses with Command, Control or Alt are left to the browser.
 */
export function listShortcutForKey(press: KeyPress): ListShortcut | undefined {
  if (press.metaKey || press.ctrlKey || press.altKey) return undefined;
  if (press.key === '?') return 'help';
  if (press.key === '/') return 'search';
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  if (key === 'x')
    return press.shiftKey ? 'extend-selection' : 'toggle-selection';
  if (press.shiftKey) return undefined;
  const plain: Record<string, ListShortcut> = {
    j: 'next',
    ArrowDown: 'next',
    k: 'previous',
    ArrowUp: 'previous',
    Enter: 'open',
    ' ': 'preview',
    Escape: 'escape',
    f: 'filter',
  };

  return plain[key];
}

/** Whether a key event targets a text field, where single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement))
    return false;

  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="combobox"], [contenteditable="true"]',
    ) !== null
  );
}

const ownKeys =
  '[role="tablist"], [role="radiogroup"], [role="menu"], [role="listbox"], [role="separator"], [role="slider"], [role="grid"], [role="tree"]';
const interactive =
  'button, input, select, textarea, summary, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';

/**
 * Whether the focused element already gives `command` a meaning: arrows inside composite
 * widgets, Enter on any control and Space on controls other than links.
 */
function targetOwnsKey(target: EventTarget | null, command: ListShortcut) {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement))
    return false;
  if (command === 'next' || command === 'previous')
    return target.closest(ownKeys) !== null;
  if (command === 'open')
    return target.closest(`${interactive}, a[href]`) !== null;
  if (command === 'preview') return target.closest(interactive) !== null;

  return false;
}

/** Whether a dialog, sheet or menu is open, so list shortcuts must wait until it closes. */
function overlayOpen() {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    ) !== null
  );
}

/** Commands the list responds to. Leave one out and its key does nothing. */
export interface ListKeyboardHandlers {
  onOpen?: ((index: number) => void) | undefined;
  onTogglePreview?: ((index: number) => void) | undefined;
  onToggleSelection?: ((index: number) => void) | undefined;
  onExtendSelection?: ((index: number) => void) | undefined;
  /** Clears the selection or closes the preview; returns whether anything changed. */
  onEscape?: (() => boolean) | undefined;
  onFocusSearch?: (() => void) | undefined;
  onOpenFilter?: (() => void) | undefined;
  onShowHelp?: (() => void) | undefined;
}

/**
 * The record shown next to the list, for lists with a preview pane. The open record usually lives
 * in the URL, so links and Back restore it.
 */
export interface ListPreview {
  /** Key of the record the preview shows, or undefined while it is closed. */
  open: string | undefined;
  /** Opens a record in the preview, or closes the preview with undefined. */
  onOpenChange: (key: string | undefined) => void;
}

/**
 * Resolves the row the keys act on. With row keys, focus follows the record, so a refresh that
 * moves it keeps it focused and one that removes it hands focus to the row now at its position.
 * Before the reader moves, the record open in the preview is the focused row.
 */
export function focusedRowIndex({
  count,
  index,
  key,
  keys,
  open,
}: {
  count: number;
  index: number;
  key?: string | undefined;
  keys?: readonly string[] | undefined;
  open?: string | undefined;
}): number {
  if (keys && key !== undefined) {
    const at = keys.indexOf(key);
    if (at >= 0) return at;
  }
  if (index >= 0) return Math.min(index, count - 1);
  if (keys && open !== undefined) return keys.indexOf(open);

  return -1;
}

/** Marks an element as a list row for keyboard navigation; spread it on each row. */
export interface ListRowProps {
  'data-list-row': '';
  'data-focused': '' | undefined;
  tabIndex: -1;
}

/** Selects the element inside a row that takes focus, before falling back to the row itself. */
const rowFocusTarget = '[data-row-focus], [data-slot="data-table-row-link"]';

/**
 * Keyboard navigation for a list or table of `count` rows inside `rows`. Rows are the elements
 * marked with `rowProps` (DataTable and CollectionList mark their rows themselves). Moving
 * focuses the row's link, or the row, and scrolls it into view; tabbing into a row also makes it
 * the focused row. Shortcuts never fire while typing, with a modifier key, or while a dialog or
 * menu is open, and keys a focused control already uses keep their meaning.
 *
 * Pass `keys` to keep focus on the same record when a refresh reorders the rows. With `preview`,
 * Space opens or closes the focused record next to the list (only while focus is in the list, so
 * Space still scrolls the preview), J and K move the open record along with focus, and Escape
 * closes the preview before anything else and returns focus to its row.
 */
export function useListKeyboard({
  rows,
  count,
  keys,
  preview,
  enabled = true,
  ...handlers
}: ListKeyboardHandlers & {
  /** Contains the rows. */
  rows: RefObject<HTMLElement | null>;
  count: number;
  /** Row keys in display order; required for `preview`. */
  keys?: readonly string[] | undefined;
  preview?: ListPreview | undefined;
  enabled?: boolean | undefined;
}) {
  const [focused, setFocused] = useState<{
    index: number;
    key?: string | undefined;
  }>({
    index: -1,
  });
  const open = preview?.open;
  // A record opened by a link, Back or another control becomes the row the keys act on.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open !== undefined) setFocused({ index: -1, key: open });
  }
  const total = keys?.length ?? count;
  const index = focusedRowIndex({
    count: total,
    index: focused.index,
    key: focused.key,
    keys,
    open,
  });
  const latest = useRef({ handlers, index, count: total, keys, preview });
  useEffect(() => {
    latest.current = { handlers, index, count: total, keys, preview };
  });

  useEffect(() => {
    if (!enabled) return;
    const focusRow = (next: number) => {
      const row =
        rows.current?.querySelectorAll<HTMLElement>('[data-list-row]')[next];
      setFocused({ index: next, key: latest.current.keys?.[next] });
      if (!row) return;
      row.scrollIntoView({ block: 'nearest' });
      const target = row.querySelector<HTMLElement>(rowFocusTarget) ?? row;
      // A row without a link takes focus itself, outside the tab order.
      if (target === row && !row.hasAttribute('tabindex')) row.tabIndex = -1;
      target.focus({ preventScroll: true });
    };
    // Space previews from the list; elsewhere, such as in the preview itself, it scrolls.
    const fromList = (target: EventTarget | null) =>
      target === document.body ||
      (target instanceof Node && !!rows.current?.contains(target));
    const onKey = (event: KeyboardEvent) => {
      const command = listShortcutForKey(event);
      if (
        !command ||
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        targetOwnsKey(event.target, command) ||
        overlayOpen() ||
        (command === 'preview' && !fromList(event.target))
      )
        return;
      const {
        handlers: on,
        index: current,
        count: total,
        keys: rowKeys,
        preview: shown,
      } = latest.current;
      if (event.repeat && command !== 'next' && command !== 'previous') return;
      const row = (callback: ((index: number) => void) | undefined) => {
        if (!callback || current < 0) return false;
        callback(current);

        return true;
      };
      const run = (callback: (() => void) | undefined) => {
        callback?.();

        return !!callback;
      };
      const move = (next: number) => {
        focusRow(next);
        // While the preview is open it follows the focused row.
        const key = rowKeys?.[next];
        if (
          shown?.open !== undefined &&
          key !== undefined &&
          key !== shown.open
        )
          shown.onOpenChange(key);

        return true;
      };
      const togglePreview = () => {
        if (on.onTogglePreview) return row(on.onTogglePreview);
        const key = rowKeys?.[current];
        if (!shown || key === undefined) return false;
        shown.onOpenChange(shown.open === key ? undefined : key);

        return true;
      };
      const handled: Record<ListShortcut, () => boolean> = {
        next: () =>
          !!total && move(current < 0 ? 0 : Math.min(total - 1, current + 1)),
        previous: () =>
          !!total && move(current < 0 ? 0 : Math.max(0, current - 1)),
        open: () => row(on.onOpen),
        preview: togglePreview,
        'toggle-selection': () => row(on.onToggleSelection),
        'extend-selection': () => row(on.onExtendSelection),
        escape: () => {
          if (shown?.open === undefined) return on.onEscape?.() ?? false;
          shown.onOpenChange(undefined);
          if (current >= 0) focusRow(current);

          return true;
        },
        search: () => run(on.onFocusSearch),
        filter: () => run(on.onOpenFilter),
        help: () => run(on.onShowHelp),
      };
      if (handled[command]()) event.preventDefault();
    };
    // Tabbing or clicking into a row makes it the row the keys act on.
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const row = event.target.closest('[data-list-row]');
      if (!row || !rows.current?.contains(row)) return;
      const all = [...rows.current.querySelectorAll('[data-list-row]')];
      const next = all.indexOf(row);
      setFocused({ index: next, key: latest.current.keys?.[next] });
    };
    // Listen on the document: the rows may mount after the hook, such as once data loads.
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [enabled, rows]);

  return {
    /** The row the keys act on, or -1 before the reader moves to one. */
    focusedIndex: index,
    /** The key of the focused row, when `keys` are given. */
    focusedKey: index >= 0 ? keys?.[index] : undefined,
    setFocusedIndex: (next: number) =>
      setFocused({ index: next, key: keys?.[next] }),
    /** Marks a plain list row; DataTable marks its own rows. */
    rowProps: (row: number): ListRowProps => ({
      'data-list-row': '',
      'data-focused': row === index ? '' : undefined,
      tabIndex: -1,
    }),
  };
}

/** Every list command, in the order shortcut help lists them. */
export const listShortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'open',
  'preview',
  'toggle-selection',
  'extend-selection',
  'escape',
  'search',
  'filter',
  'help',
];

/** Keys for each list command, as shown in shortcut help. Alternatives are separate entries. */
export const listShortcutKeys: Record<ListShortcut, readonly string[][]> = {
  next: [['J'], ['↓']],
  previous: [['K'], ['↑']],
  open: [['Enter']],
  preview: [['Space']],
  'toggle-selection': [['X']],
  'extend-selection': [['Shift', 'X']],
  escape: [['Esc']],
  search: [['/']],
  filter: [['F']],
  help: [['?']],
};
