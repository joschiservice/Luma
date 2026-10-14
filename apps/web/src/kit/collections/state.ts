import {
  type CollectionCatalog,
  collectionColumnSchema,
  type CollectionGranularity,
  collectionLayoutSchema,
  type CollectionViewState,
  collectionViewStateSchema,
  type CollectionWhere,
  collectionWhereSchema,
} from '@luma/api-contract';
import { z } from 'zod';

const fieldId = z
  .string()
  .regex(/^(?:[a-z][a-zA-Z0-9]{0,63}|custom:[0-9a-f-]{36})$/);

const savedViewId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * URL keys every configurable list shares. `view` is a built-in segment such as `overdue` or a
 * saved view ID, so links from before saved views keep working. The other view keys hold only
 * changes from that view; search text and paging are never part of a view.
 */
export const collectionSearchShape = {
  view: z
    .string()
    .regex(/^(?:[a-z][a-z_]{0,59}|[0-9a-f-]{36})$/)
    .optional()
    .catch(undefined),
  where: collectionWhereSchema.optional().catch(undefined),
  sort: fieldId.optional().catch(undefined),
  direction: z.enum(['asc', 'desc']).optional().catch(undefined),
  group: z
    .string()
    .regex(
      /^(?:[a-z][a-zA-Z0-9]{0,63}|custom:[0-9a-f-]{36})(?::(?:day|week|month))?$/,
    )
    .optional()
    .catch(undefined),
  empty: z.boolean().optional().catch(undefined),
  layout: collectionLayoutSchema.optional().catch(undefined),
  columns: z.array(collectionColumnSchema).max(40).optional().catch(undefined),
  properties: z.array(fieldId).max(20).optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
  q: z.string().max(120).optional().catch(undefined),
  cursor: z.string().max(8192).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).optional().catch(undefined),
};

export const collectionSearch = z.object(collectionSearchShape);

export type CollectionSearch = z.infer<typeof collectionSearch>;

/** Keys that describe the view, as opposed to search text, paging and page context. */
const viewKeys = [
  'view',
  'where',
  'sort',
  'direction',
  'group',
  'empty',
  'layout',
  'columns',
  'properties',
  'preview',
] as const;

/** The view a page shows: a saved view, or one of the catalog's built-in segments. */
export type CollectionViewRef =
  { kind: 'saved'; id: string } | { kind: 'builtin'; segment: string };

/** Resolves the URL's `view` to a saved view or a known segment, defaulting to the first. */
export function viewRef(
  catalog: CollectionCatalog,
  view: string | undefined,
): CollectionViewRef {
  if (view && savedViewId.test(view)) return { kind: 'saved', id: view };
  const segment =
    view && catalog.segments.includes(view) ? view : catalog.segments[0];

  return { kind: 'builtin', segment: segment ?? 'all' };
}

/** The member-state key of a view: its ID, or `builtin:<segment>`. */
export function viewKey(ref: CollectionViewRef): string {
  return ref.kind === 'saved' ? ref.id : `builtin:${ref.segment}`;
}

/** Converts a member-state view key back to the URL's `view` value. */
export function viewParam(key: string): string {
  return key.startsWith('builtin:') ? key.slice(8) : key;
}

/**
 * The definition of a built-in view: its segment with the catalog's defaults, in the catalog's
 * first layout, so a list-only page starts as a list.
 */
export function builtinState(
  catalog: CollectionCatalog,
  segment: string,
): CollectionViewState {
  return collectionViewStateSchema.parse({
    segment,
    sort: catalog.defaultSort,
    layout: catalog.layouts[0] ?? 'table',
  });
}

function groupParam(state: CollectionViewState): string | undefined {
  if (!state.group) return undefined;

  return state.group.granularity
    ? `${state.group.field}:${state.group.granularity}`
    : state.group.field;
}

function parseGroup(value: string, showEmpty: boolean) {
  const [field, granularity] = value.split(':') as [
    string,
    CollectionGranularity | undefined,
  ];

  return { field, ...(granularity ? { granularity } : {}), showEmpty };
}

/**
 * Applies the URL's changes to a view's definition. A key present in the URL replaces the
 * view's value for that key; the rest comes from the view.
 */
export function effectiveState(
  base: CollectionViewState,
  search: CollectionSearch,
): CollectionViewState {
  const sort =
    search.sort !== undefined
      ? { field: search.sort, direction: search.direction ?? 'desc' }
      : search.direction && base.sort
        ? { ...base.sort, direction: search.direction }
        : base.sort;
  const group =
    search.group !== undefined
      ? search.group === ''
        ? null
        : parseGroup(search.group, search.empty ?? false)
      : base.group && search.empty !== undefined
        ? { ...base.group, showEmpty: search.empty }
        : base.group;
  const layout = search.layout ?? base.layout;

  return {
    ...base,
    where: search.where ?? base.where,
    sort,
    group,
    // A board needs a grouping; without one the list shows as a table.
    layout: layout === 'board' && !group ? 'table' : layout,
    columns: search.columns ?? base.columns,
    properties: search.properties ?? base.properties,
    preview: search.preview ?? base.preview,
  };
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasConditions(where: CollectionWhere) {
  return where.conditions.length > 0;
}

/**
 * Returns the URL keys that express `next` as changes to `base`, so the URL holds only what
 * differs from the view. The `view` key itself is not included.
 */
export function stateChanges(
  base: CollectionViewState,
  next: CollectionViewState,
): Partial<CollectionSearch> {
  const changes: Partial<CollectionSearch> = {};
  if (
    !same(next.where, base.where) &&
    (hasConditions(next.where) || hasConditions(base.where))
  )
    changes.where = next.where;
  if (!same(next.sort, base.sort)) {
    if (next.sort) {
      changes.sort = next.sort.field;
      changes.direction = next.sort.direction;
    }
  }
  if (!same(next.group, base.group)) {
    changes.group = groupParam(next) ?? '';
    if (next.group?.showEmpty) changes.empty = true;
  }
  if (next.layout !== base.layout) changes.layout = next.layout;
  if (!same(next.columns, base.columns)) changes.columns = next.columns;
  if (!same(next.properties, base.properties))
    changes.properties = next.properties;
  if (next.preview !== base.preview) changes.preview = next.preview;

  return changes;
}

/** Reports whether the URL changes what the view means, which the view bar shows as Modified. */
export function isModified(
  base: CollectionViewState,
  search: CollectionSearch,
): boolean {
  return (
    Object.keys(stateChanges(base, effectiveState(base, search))).length > 0
  );
}

/** True when the URL names a view or view changes, as links and drill-downs do. */
export function hasViewInUrl(search: Record<string, unknown>): boolean {
  return viewKeys.some((key) => search[key] !== undefined);
}

/** Builds the URL for a view with optional unsaved changes, starting on the first page. */
export function viewSearch(
  ref: CollectionViewRef,
  base: CollectionViewState,
  draft: CollectionViewState | null,
): Partial<CollectionSearch> {
  return {
    view: ref.kind === 'saved' ? ref.id : ref.segment,
    ...(draft ? stateChanges(base, draft) : {}),
  };
}

/** Parses a `group` URL value for list APIs that take the field and granularity separately. */
export function groupOf(state: CollectionViewState): string | undefined {
  return groupParam(state);
}
