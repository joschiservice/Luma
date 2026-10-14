/** A shown table column and the width people resized it to, in pixels. */
export interface DataTableColumnSetting {
  key: string;
  width?: number | undefined;
}

/**
 * Which columns a configurable table shows, in which order and at which widths. Columns missing
 * from `columns` are hidden; an empty list shows every column in definition order.
 */
export interface DataTableColumnState {
  columns: readonly DataTableColumnSetting[];
  /** Keeps this shown column first and in view while the table scrolls sideways. */
  pinned?: string | undefined;
}

/** Narrowest and widest column a person can resize to, matching saved view limits. */
const columnWidthLimits = { min: 48, max: 960 } as const;

/** Keeps a width within the resize limits, rounded to whole pixels. */
export function clampColumnWidth(width: number): number {
  return Math.round(
    Math.min(columnWidthLimits.max, Math.max(columnWidthLimits.min, width)),
  );
}

/**
 * The shown columns in display order: known keys from the state, the pinned column first, and
 * `required` columns added at the front when the state leaves them out.
 */
export function shownColumns(
  state: DataTableColumnState,
  keys: readonly string[],
  required: readonly string[] = [],
): DataTableColumnSetting[] {
  const known = new Set(keys);
  const seen = new Set<string>();
  const listed = (
    state.columns.length ? state.columns : keys.map((key) => ({ key }))
  ).filter((column) => {
    if (!known.has(column.key) || seen.has(column.key)) return false;
    seen.add(column.key);

    return true;
  });
  const missing = required
    .filter((key) => known.has(key) && !seen.has(key))
    .map((key) => ({ key }));
  const shown = [...missing, ...listed];
  const pinned = shown.findIndex((column) => column.key === state.pinned);
  if (pinned > 0) shown.unshift(...shown.splice(pinned, 1));

  return shown;
}

function withColumns(
  state: DataTableColumnState,
  columns: DataTableColumnSetting[],
): DataTableColumnState {
  const pinned = columns.some((column) => column.key === state.pinned)
    ? state.pinned
    : undefined;

  return pinned ? { columns, pinned } : { columns };
}

/**
 * Moves a shown column by `offset` places. The pinned column stays first, so other columns never
 * move in front of it.
 */
export function moveColumn(
  state: DataTableColumnState,
  keys: readonly string[],
  key: string,
  offset: number,
  required: readonly string[] = [],
): DataTableColumnState {
  const columns = shownColumns(state, keys, required);
  const from = columns.findIndex((column) => column.key === key);
  const first = state.pinned && key !== state.pinned ? 1 : 0;
  if (from < 0 || (state.pinned === key && offset !== 0)) return state;
  const to = Math.min(columns.length - 1, Math.max(first, from + offset));
  if (to === from) return state;
  columns.splice(to, 0, ...columns.splice(from, 1));

  return withColumns(state, columns);
}

/** Shows or hides one column; a shown column joins at the end. Required columns stay shown. */
export function setColumnShown(
  state: DataTableColumnState,
  keys: readonly string[],
  key: string,
  shown: boolean,
  required: readonly string[] = [],
): DataTableColumnState {
  const columns = shownColumns(state, keys, required);
  const index = columns.findIndex((column) => column.key === key);
  if (shown === index >= 0 || !keys.includes(key)) return state;
  if (shown) return withColumns(state, [...columns, { key }]);
  if (required.includes(key) || columns.length === 1) return state;

  return withColumns(
    state,
    columns.filter((column) => column.key !== key),
  );
}

/** Sets one column's width, or returns it to its default width when `width` is undefined. */
export function setColumnWidth(
  state: DataTableColumnState,
  keys: readonly string[],
  key: string,
  width: number | undefined,
  required: readonly string[] = [],
): DataTableColumnState {
  return withColumns(
    state,
    shownColumns(state, keys, required).map((column) =>
      column.key === key
        ? width === undefined
          ? { key }
          : { key, width: clampColumnWidth(width) }
        : column,
    ),
  );
}

/** Pins a shown column first, or unpins with undefined. */
export function pinColumn(
  state: DataTableColumnState,
  keys: readonly string[],
  key: string | undefined,
  required: readonly string[] = [],
): DataTableColumnState {
  const columns = shownColumns(state, keys, required);
  if (key === undefined || !columns.some((column) => column.key === key))
    return { columns };

  return { columns: shownColumns({ columns, pinned: key }, keys), pinned: key };
}
