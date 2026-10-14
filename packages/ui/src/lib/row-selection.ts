import { useRef } from 'react';

/**
 * Selects or clears every row between `anchor` and `index`, inclusive, keeping selected rows
 * outside the range. Keys not on the page stay as they are.
 */
export function selectRange(
  keys: readonly string[],
  selected: readonly string[],
  anchor: number,
  index: number,
  select: boolean,
): string[] {
  const start = Math.max(0, Math.min(anchor, index));
  const end = Math.min(keys.length - 1, Math.max(anchor, index));
  const range = new Set(keys.slice(start, end + 1));
  const kept = selected.filter((key) => !range.has(key));

  return select ? [...kept, ...range] : kept;
}

/** Selection state for a page of rows, keyed by row key. */
export interface RowSelection {
  /** Toggles one row; `extend` applies the row's new state to every row since the last toggle. */
  toggle: (index: number, extend?: boolean) => void;
  /** Selects every row on the page, or clears them when all are selected. */
  toggleAll: () => void;
  clear: () => void;
  isSelected: (key: string) => boolean;
  allSelected: boolean;
  someSelected: boolean;
}

/**
 * Tracks the range anchor for shift-click and Shift+X selection. The caller owns `selected` and
 * receives every change through `onChange`.
 */
export function useRowSelection({
  keys,
  selected,
  onChange,
}: {
  keys: readonly string[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}): RowSelection {
  const anchor = useRef<string | undefined>(undefined);
  const chosen = new Set(selected);
  const onPage = keys.filter((key) => chosen.has(key)).length;

  return {
    toggle(index, extend = false) {
      const key = keys[index];
      if (key === undefined) return;
      const select = !chosen.has(key);
      const from = anchor.current ? keys.indexOf(anchor.current) : -1;
      anchor.current = key;
      if (extend && from >= 0)
        return onChange(selectRange(keys, selected, from, index, select));
      onChange(
        select ? [...selected, key] : selected.filter((item) => item !== key),
      );
    },
    toggleAll() {
      const page = new Set(keys);
      const others = selected.filter((key) => !page.has(key));
      onChange(onPage === keys.length ? others : [...others, ...keys]);
    },
    clear() {
      anchor.current = undefined;
      onChange([]);
    },
    isSelected: (key) => chosen.has(key),
    allSelected: keys.length > 0 && onPage === keys.length,
    someSelected: onPage > 0 && onPage < keys.length,
  };
}
