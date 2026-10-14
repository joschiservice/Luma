import type {
  CollectionFieldDefinition,
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { useEffect, useRef, useState } from 'react';

import type { CatalogPresentation, RuntimeOptions } from './fields';

/** Identifies a group by its key in member state and the URL, such as `"open"` or `null`. */
export function groupId(key: CollectionGroup['key']): string {
  return JSON.stringify(key);
}

interface GroupPage<Row> {
  rows: Row[];
  cursor: string | null;
  pending: boolean;
  failed: boolean;
}

/** Rows "Show more" added to one group, and how to load the next page of it. */
export interface GroupMore<Row> {
  /** Rows loaded after the group's first rows. */
  rows: readonly Row[];
  /** Loads the next page; undefined when the group has no more rows. */
  load: (() => void) | undefined;
  pending: boolean;
  failed: boolean;
}

/**
 * Pages inside the groups of a grouped list. Each group starts with the rows the grouped read
 * returned; "Show more" reads that group's next page with its cursor and appends it. Loaded
 * pages are dropped when `resetKey` changes, which must happen whenever the view, search or
 * grouping changes, because group cursors are bound to them.
 */
export function useGroupPages<Row>({
  resetKey,
  load,
}: {
  resetKey: string;
  load: (
    key: CollectionGroup['key'],
    cursor: string,
  ) => Promise<{ rows: Row[]; nextCursor: string | null }>;
}) {
  const [state, setState] = useState<{
    resetKey: string;
    groups: Record<string, GroupPage<Row>>;
  }>({ resetKey, groups: {} });
  const latest = useRef(resetKey);
  useEffect(() => {
    latest.current = resetKey;
  });
  const groups = state.resetKey === resetKey ? state.groups : {};

  const update = (id: string, page: Partial<GroupPage<Row>>) =>
    setState((current) => {
      const base = current.resetKey === resetKey ? current.groups : {};
      const previous = base[id] ?? {
        rows: [],
        cursor: null,
        pending: false,
        failed: false,
      };

      return {
        resetKey,
        groups: { ...base, [id]: { ...previous, ...page } },
      };
    });

  return (group: CollectionGroup): GroupMore<Row> => {
    const id = groupId(group.key);
    const page = groups[id];
    const cursor = page ? page.cursor : group.nextCursor;

    return {
      rows: page?.rows ?? [],
      pending: page?.pending ?? false,
      failed: page?.failed ?? false,
      load: cursor
        ? () => {
            if (page?.pending) return;
            const started = resetKey;
            update(id, { pending: true, failed: false });
            load(group.key, cursor).then(
              (result) => {
                if (latest.current !== started) return;
                update(id, {
                  rows: [...(page?.rows ?? []), ...result.rows],
                  cursor: result.nextCursor,
                  pending: false,
                });
              },
              () => {
                if (latest.current === started)
                  update(id, { pending: false, failed: true });
              },
            );
          }
        : undefined,
    };
  };
}

/** One group of a grouped list with its rows in display order. */
export interface ShownGroup<Row> {
  group: CollectionGroup;
  id: string;
  rows: Row[];
  more: GroupMore<Row> | undefined;
}

/**
 * The groups a grouped list shows: the list's groups in its order, with their first rows and any
 * rows "Show more" loaded. With `showEmpty`, choice and yes/no fields also list their options that
 * matched nothing, in the catalog's order; other fields can't name groups without a record.
 */
export function shownGroups<Row>({
  items,
  groups = [],
  rowKey,
  field,
  showEmpty,
  more,
}: {
  items: readonly Row[];
  groups?: readonly CollectionGroup[] | undefined;
  rowKey: (row: Row) => string;
  field: CollectionFieldDefinition | undefined;
  showEmpty: boolean;
  more: (group: CollectionGroup) => GroupMore<Row> | undefined;
}): ShownGroup<Row>[] {
  const byId = new Map(items.map((item) => [rowKey(item), item]));
  const keys: CollectionGroup['key'][] | undefined = !showEmpty
    ? undefined
    : field?.type === 'boolean'
      ? [true, false]
      : field?.options
        ? [...field.options]
        : undefined;
  const shown = keys
    ? [
        ...keys.map(
          (key) =>
            groups.find((group) => group.key === key) ?? {
              key,
              count: 0,
              complete: true,
              itemIds: [],
              nextCursor: null,
              sums: [],
            },
        ),
        ...groups.filter((group) => !keys.includes(group.key)),
      ]
    : groups.filter((group) => group.count > 0);

  return shown.map((group) => {
    const extra = more(group);
    const first = group.itemIds.flatMap((id) => {
      const item = byId.get(id);

      return item ? [item] : [];
    });
    const seen = new Set(first.map(rowKey));

    return {
      group,
      id: groupId(group.key),
      rows: [
        ...first,
        ...(extra?.rows ?? []).filter((item) => !seen.has(rowKey(item))),
      ],
      more: extra,
    };
  });
}

/** The "Show more" button of a group, or undefined when the group has no more rows. */
export function groupMoreButton<Row>(more: GroupMore<Row> | undefined) {
  return more?.load
    ? {
        onClick: more.load,
        pending: more.pending,
        ...(more.failed ? { label: m.collections_group_more_failed() } : {}),
      }
    : undefined;
}

/**
 * Names one group of a list: an option's label, a run-time option's name (such as a source or
 * location), a calendar period in the workspace time zone (the server returns the period's first
 * day), or "No value" for records without one. `runtime` names fields whose keys are IDs of
 * run-time options; `name` can name other keys, such as an ID only the rows know.
 */
export function collectionGroupLabel({
  presentation,
  field,
  granularity,
  key,
  options = {},
  runtime = {},
  name,
}: {
  presentation: CatalogPresentation;
  field: string;
  granularity: CollectionGranularity | undefined;
  key: CollectionGroup['key'];
  options?: RuntimeOptions | undefined;
  runtime?: Readonly<Record<string, keyof RuntimeOptions>> | undefined;
  name?: ((text: string) => string | undefined) | undefined;
}): string {
  if (key === null) return m.collections_group_none();
  const shown = presentation[field];
  if (typeof key === 'boolean')
    return m.collections_group_boolean({
      field: shown?.label() ?? field,
      value: key ? m.common_yes() : m.common_no(),
    });
  const text = String(key);
  const source = runtime[field];
  if (source)
    return (
      options[source]?.find((option) => option.value === text)?.label ??
      name?.(text) ??
      text
    );
  const day = /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
  if (granularity && day)
    return granularity === 'day'
      ? formatCalendarDate(day)
      : granularity === 'week'
        ? m.collections_group_week({ date: formatCalendarDate(day) })
        : formatCalendarDate(day, { month: 'long', year: 'numeric' });

  return shown?.option?.(text) ?? name?.(text) ?? text;
}
