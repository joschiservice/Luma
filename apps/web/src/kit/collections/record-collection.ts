import {
  type CollectionCatalog,
  type CollectionGroup,
  type CollectionViewState,
  collectionWhereIssues,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  type DefaultError,
  type FetchQueryOptions,
  type QueryKey,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';

import { ApiError } from '../identity/data';
import type { CustomFieldColumn } from './fields';
import { useGroupPages } from './groups';
import {
  type CollectionError,
  collectionError,
  collectionServerIssue,
} from './paging';
import { repairedState } from './repair';
import { groupOf } from './state';
import type { CollectionView } from './use-collection-view';

/** The page of a list read the shared collection plumbing needs. */
interface RecordPage {
  items: unknown[];
  groups?: readonly CollectionGroup[] | null | undefined;
  nextCursor: string | null;
}

/** A problem with the view, tied to one condition or, with a null index, to the view. */
type ViewIssue = { index: number | null };

/**
 * Reads one page of a configurable record list and works out what the view can't do.
 *
 * Inputs: the list's `catalog`; the member's `view`, which repair and collapsing groups change;
 * `state`, the view as the page shows it when the page adjusts it, such as a default sort (checks
 * and grouping read it, repair starts from `view.state`); the reader's `permissions` from
 * `usePermissions`; the URL's page `cursor`; the page's read as query options (`list`), which
 * runs only when the checks pass; and the read of one group's next page (`groupPage`) with the
 * `resetKey` its loaded pages belong to, which must change with the request.
 *
 * Conditions are checked on the client once permissions are known, and once the list's custom
 * fields are known when the view uses one; the list isn't read while a check fails. Optional
 * differences between lists:
 * - `customFields`: the list offers custom fields; the workspace availability read, the list's
 *   field definitions read and their columns decide when custom conditions can be checked.
 * - `gatedFields`: the list refuses with 403 a view that uses a field the reader may not read.
 *   A 403 for a reader who holds the catalog's read permission then needs repair instead of
 *   meaning lost access.
 * - `serverIssueIndex`: maps a condition index of the request to the view's index, when the
 *   page sends conditions the view doesn't show as written.
 * - `repair`: replaces the shared repair, for lists that drop more than it does.
 *
 * Returns the list query, the server's issue for the toolbar (undefined with a page
 * cursor, where a refused request means the link is stale), `repair` (undefined when nothing
 * needs repair), `error` (`invalid` for a view needing repair, otherwise the classified read
 * failure, undefined while loading or loaded), the grouping with its collapsed groups and
 * `setCollapsed`, and `more` for "Show more" inside groups.
 */
export function useRecordCollection<
  Page extends RecordPage,
  Key extends QueryKey,
>({
  catalog,
  view,
  state = view.state,
  permissions,
  cursor,
  list: listOptions,
  resetKey,
  groupPage,
  customFields,
  gatedFields = false,
  serverIssueIndex,
  repair: repairView = (current, issues) =>
    repairedState(catalog, current, issues, permissions.can),
}: {
  catalog: CollectionCatalog;
  view: CollectionView;
  state?: CollectionViewState;
  permissions: { ready: boolean; can: (permission: string) => boolean };
  cursor: string | undefined;
  list: UseQueryOptions<Page, DefaultError, Page, Key>;
  resetKey: string;
  groupPage: (
    key: CollectionGroup['key'],
    cursor: string,
  ) => FetchQueryOptions<Page, DefaultError, Page, Key>;
  customFields?: {
    availability: {
      isSuccess: boolean;
      data?: { fields: boolean } | undefined;
    };
    definitions: { isSuccess: boolean; isError: boolean };
    columns: readonly CustomFieldColumn[];
  };
  gatedFields?: boolean;
  serverIssueIndex?: (index: number | null) => number | null;
  repair?: (
    state: CollectionViewState,
    issues: readonly ViewIssue[],
  ) => CollectionViewState;
}) {
  const queryClient = useQueryClient();
  const can = permissions.can;

  // Problems the client can see before asking, once permissions and custom fields are known.
  const usesCustom = state.where.conditions.some((condition) =>
    condition.field.startsWith('custom:'),
  );
  const fieldsKnown =
    !customFields ||
    !usesCustom ||
    customFields.definitions.isSuccess ||
    customFields.definitions.isError ||
    (customFields.availability.isSuccess &&
      permissions.ready &&
      !(customFields.availability.data?.fields && can('adaptive.fields.read')));
  const ready = permissions.ready && fieldsKnown;
  const fieldPermissions = new Set(
    catalog.fields.flatMap((field) =>
      field.permission && can(field.permission) ? [field.permission] : [],
    ),
  );
  const clientIssues = ready
    ? collectionWhereIssues(catalog, state.where, {
        permissions: fieldPermissions,
        ...(customFields
          ? {
              customFieldTypes: new Map(
                customFields.columns
                  .filter((field) => !field.archived)
                  .map((field) => [field.id, field.type]),
              ),
            }
          : {}),
      })
    : [];
  const list = useQuery({
    ...listOptions,
    enabled: ready && !clientIssues.length,
  });

  // With a page cursor, a refused request means the page link is stale, not the view.
  const sentIssue = cursor ? undefined : collectionServerIssue(list.error);
  const serverIssue =
    sentIssue && serverIssueIndex
      ? { ...sentIssue, index: serverIssueIndex(sentIssue.index) }
      : sentIssue;
  // A 403 for a reader who can read the list means a field the view uses is closed to them.
  const fieldDenied =
    gatedFields &&
    list.error instanceof ApiError &&
    list.error.status === 403 &&
    can(catalog.permission);
  const issues: ViewIssue[] = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repairView(view.state, issues))
    : undefined;
  const error: CollectionError | undefined =
    clientIssues.length || fieldDenied
      ? { kind: 'invalid', message: m.collections_needs_repair() }
      : collectionError(list.error, cursor);

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  // Collapsed groups are scoped to the grouping and keep the member's last 100.
  const setCollapsed = (id: string, closed: boolean) =>
    view.setDisplay({
      ...view.display,
      collapsedGroups: [
        ...view.display.collapsedGroups.filter(
          (item) => item !== `${groupPrefix}${id}`,
        ),
        ...(closed ? [`${groupPrefix}${id}`] : []),
      ].slice(-100),
    });
  const more = useGroupPages<Page['items'][number]>({
    resetKey,
    load: (key, groupCursor) =>
      queryClient.fetchQuery(groupPage(key, groupCursor)).then((page) => ({
        rows: page.items,
        nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
      })),
  });

  return {
    list,
    serverIssue,
    repair,
    error,
    grouping,
    collapsed,
    setCollapsed,
    more,
  };
}
