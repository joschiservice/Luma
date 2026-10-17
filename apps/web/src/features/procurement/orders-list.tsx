import {
  type CollectionGroup,
  collectionWhereIssues,
  procurementCatalog,
  type PurchaseOrderList,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { selectRange } from '@luma/ui/lib/row-selection';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, Maximize2 } from 'lucide-react';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import { useGroupPages } from '../../kit/collections/groups';
import {
  CollectionLoading,
  CollectionNotices,
} from '../../kit/collections/notices';
import {
  type CollectionError,
  collectionError,
  collectionServerIssue,
  useCursorPaging,
  useOnline,
} from '../../kit/collections/paging';
import { repairedState } from '../../kit/collections/repair';
import { type CollectionSearch, groupOf } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { allSuppliersOptions } from '../../shared/procurement/suppliers';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import {
  adaptiveAvailabilityOptions,
  customFieldsOptions,
  customFieldValuesOptions,
} from '../adaptive/data';
import { customFieldColumns, customFieldText } from '../adaptive/presentation';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { fulfillmentsOptions } from '../fulfillment/data';
import {
  purchaseOrderGroupLabel,
  purchaseOrderSegmentLabel,
  purchaseOrdersPresentation,
} from './collection';
import {
  ordersOptions,
  procurementPageSize,
  type ProcurementSearch,
  purchaseOrderListQuery,
} from './data';
import type { ListedPurchaseOrder } from './fields';
import { PurchaseOrderPreview } from './order-preview';
import { purchaseOrderGroups, PurchaseOrderResults } from './order-results';

/** The list commands the purchase-order list handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
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

/**
 * The purchase-order list of the procurement page: the member's view with its conditions, sort,
 * grouping and layout from the URL and remembered state, the shared toolbar and view bar, list
 * keys, a preview pane and keyset paging. Readable custom fields show as columns and can filter
 * and sort the list. `onCounts` receives the workspace counts an unfiltered first page carries,
 * so the overview needs no second read.
 */
export function PurchaseOrdersList({
  organizationId,
  search,
  tabs,
  empty,
  onCounts,
}: {
  organizationId: string;
  search: ProcurementSearch;
  /** The procurement page's list tabs, shown before the view menu. */
  tabs: ReactNode;
  /** Shown while the workspace has no purchase orders; the list explains filtered results. */
  empty: ReactNode;
  onCounts: (counts: PurchaseOrderList['counts']) => void;
}) {
  const navigate = useNavigate({ from: '/app/$organizationId/procurement/' });
  const queryClient = useQueryClient();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: ProcurementSearch) =>
    void navigate({ search: next, resetScroll: false });
  // Clearing conditions also clears search text; other view changes keep it.
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: procurementCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        ...(keepQuery.current && search.q ? { q: search.q } : {}),
        ...(search.item ? { item: search.item } : {}),
        ...next,
      } as ProcurementSearch),
  });
  const state = view.state;

  const suppliers = useQuery(allSuppliersOptions(organizationId));
  const locations = useQuery({
    ...fulfillmentsOptions(organizationId, { view: 'open' }, 1),
    enabled: can('fulfillment.read'),
    staleTime: 5 * 60_000,
  });
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const fields = useQuery({
    ...customFieldsOptions(organizationId, 'purchase_order'),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  const custom = customFieldColumns(fields.data ?? []);
  const options = {
    suppliers: (suppliers.data?.items ?? []).map((supplier) => ({
      value: supplier.id,
      label: supplier.name,
    })),
    locations: (locations.data?.locations ?? []).map((location) => ({
      value: location.id,
      label: location.name ?? m.procurement_list_location_unnamed(),
    })),
  };
  const locationNames = new Map(
    options.locations.map((option) => [option.value, option.label]),
  );

  // Problems the client can see before asking, once permissions and custom fields are known.
  const usesCustom = state.where.conditions.some((condition) =>
    condition.field.startsWith('custom:'),
  );
  const fieldsKnown =
    !usesCustom ||
    fields.isSuccess ||
    fields.isError ||
    (availability.isSuccess &&
      permissions.ready &&
      !(availability.data.fields && can('adaptive.fields.read')));
  const ready = permissions.ready && fieldsKnown;
  const clientIssues = ready
    ? collectionWhereIssues(procurementCatalog, state.where, {
        permissions: new Set(
          procurementCatalog.fields.flatMap((field) =>
            field.permission && can(field.permission) ? [field.permission] : [],
          ),
        ),
        customFieldTypes: new Map(
          custom
            .filter((field) => !field.archived)
            .map((field) => [field.id, field.type]),
        ),
      })
    : [];
  const query = purchaseOrderListQuery(state, search, timeZone);
  const list = useQuery({
    ...ordersOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  const counts = list.data?.counts;
  useEffect(() => {
    if (counts) onCounts(counts);
  }, [counts, onCounts]);
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const currencies = [
    ...new Set(
      (list.data?.items ?? []).flatMap((item) =>
        item.summary.value && item.summary.value !== 'unknown'
          ? [item.summary.value.currency]
          : [],
      ),
    ),
  ];
  const controls = useCollectionControls({
    view,
    catalog: procurementCatalog,
    presentation: purchaseOrdersPresentation,
    can,
    options,
    currencies,
    custom,
    required: ['reference'],
    title: 'reference',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  // A 403 for a reader who can read purchase orders means a custom field the view uses is
  // closed to them.
  const fieldDenied =
    list.error instanceof ApiError &&
    list.error.status === 403 &&
    can('procurement.read');
  const issues = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repairedState(procurementCatalog, state, issues, can))
    : undefined;
  const error: CollectionError | undefined =
    clientIssues.length || fieldDenied
      ? { kind: 'invalid', message: m.collections_needs_repair() }
      : collectionError(list.error, search.cursor);

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const resetKey = JSON.stringify([organizationId, query]);
  const more = useGroupPages<ListedPurchaseOrder>({
    resetKey,
    load: (key: CollectionGroup['key'], cursor: string) =>
      queryClient
        .fetchQuery(
          ordersOptions(
            organizationId,
            purchaseOrderListQuery(state, search, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const data = list.data;
  const groups =
    data && grouping && data.groups
      ? purchaseOrderGroups(data, grouping, more)
      : [];
  // Keys in the order rows appear on the page, so the list keys follow the screen.
  const keys = grouping
    ? groups
        .filter(
          (group) => state.layout === 'board' || !collapsed.includes(group.id),
        )
        .flatMap((group) => group.rows.map((row) => row.id))
    : (data?.items ?? []).map((row) => row.id);
  const rowsById = new Map(
    [...(data?.items ?? []), ...groups.flatMap((group) => group.rows)].map(
      (row) => [row.id, row],
    ),
  );
  // Custom field columns read the shown orders' values in one request per page.
  const customShown = custom.filter((field) =>
    controls.columns.includes(`custom:${field.id}`),
  );
  const customValues = useQuery({
    ...customFieldValuesOptions(organizationId, 'purchase_order', [
      ...rowsById.keys(),
    ]),
    enabled:
      customShown.length > 0 && rowsById.size > 0 && state.layout === 'table',
  });
  const extraColumns = customShown.map((field) => ({
    key: `custom:${field.id}`,
    header: field.label,
    hideOnNarrow: true,
    cell: (order: ListedPurchaseOrder) =>
      field.archived
        ? m.collections_field_archived()
        : customFieldText(
            field,
            customValues.data?.values.find(
              (value) =>
                value.recordId === order.id && value.fieldId === field.id,
            )?.value,
          ),
  }));

  const paging = useCursorPaging({
    key: JSON.stringify([
      organizationId,
      'procurement',
      view.key,
      query.stage,
      query.where,
      query.sort,
      query.direction,
      query.q,
    ]),
    cursor: search.cursor,
    page: search.page,
    nextCursor: grouping ? null : data?.nextCursor,
    go: ({ cursor, page }) => go({ ...search, cursor, page }),
  });

  const searchInput = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  // Selection belongs to one page of one view; changing either starts empty.
  const selectionKey = JSON.stringify([query, search.cursor]);
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({
    key: selectionKey,
    ids: [],
  });
  const selected = selection.key === selectionKey ? selection.ids : [];
  const setSelected = (next: string[] | ((current: string[]) => string[])) =>
    setSelection((current) => {
      const ids = current.key === selectionKey ? current.ids : [];

      return {
        key: selectionKey,
        ids: typeof next === 'function' ? next(ids) : next,
      };
    });
  const anchor = useRef<number>(-1);
  const previewOn = state.preview && state.layout !== 'board';
  const open = previewOn ? search.item : undefined;
  const setOpen = (item: string | undefined) => go({ ...search, item });
  const openOrder = (purchaseOrderId: string) =>
    void navigate({
      to: '/app/$organizationId/procurement/$purchaseOrderId',
      params: { organizationId, purchaseOrderId },
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openOrder(key);
    },
    onToggleSelection: (index) => {
      const key = keys[index];
      if (!key) return;
      anchor.current = index;
      setSelected((current) =>
        current.includes(key)
          ? current.filter((item) => item !== key)
          : [...current, key],
      );
    },
    onExtendSelection: (index) => {
      const from = anchor.current < 0 ? index : anchor.current;
      const key = keys[index];
      if (!key) return;
      setSelected((current) =>
        selectRange(keys, current, from, index, !current.includes(key)),
      );
      anchor.current = index;
    },
    onEscape: () => {
      if (!selected.length) return false;
      setSelected([]);

      return true;
    },
    onFocusSearch: () => searchInput.current?.focus(),
    onOpenFilter: () => controls.conditions.onOpenChange?.(true),
    onShowHelp: () => setHelp(true),
  });

  if (list.error instanceof ApiError && list.error.status === 401)
    return <SignInRedirect />;

  const link = (order: ListedPurchaseOrder) => (
    <Link
      id={`purchase-order-${order.id}`}
      to="/app/$organizationId/procurement/$purchaseOrderId"
      params={{ organizationId, purchaseOrderId: order.id }}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(order.id);
      }}
    />
  );
  const clear = () => {
    keepQuery.current = false;
    view.reset();
    keepQuery.current = true;
  };
  const filtered =
    !!search.q ||
    state.where.conditions.length > 0 ||
    (state.segment ?? 'all') !== 'all';
  const viewName =
    view.saved?.name ?? purchaseOrderSegmentLabel(state.segment ?? 'all');
  const sortLabel = state.sort
    ? (purchaseOrdersPresentation[state.sort.field]?.label() ??
      custom.find((field) => `custom:${field.id}` === state.sort?.field)
        ?.label ??
      state.sort.field)
    : '';
  const shown = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <PurchaseOrderResults
        extraColumns={extraColumns}
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.procurement_list_caption({
          view: viewName,
          sort: sortLabel,
        })}
        link={link}
        empty={
          filtered ? (
            <Empty>
              <FileText size={30} aria-hidden="true" />
              <h3>{m.procurement_list_orders_filtered_title()}</h3>
              <p>{m.procurement_list_unmatched_body()}</p>
              <Button variant="outline" onClick={clear}>
                {m.common_clear_filters()}
              </Button>
            </Empty>
          ) : (
            empty
          )
        }
        sort={
          state.sort
            ? { key: state.sort.field, direction: state.sort.direction }
            : undefined
        }
        onSortChange={(next) =>
          view.change({
            ...state,
            sort: { field: next.key, direction: next.direction },
          })
        }
        columnState={controls.columnState}
        onColumnStateChange={controls.onColumnStateChange}
        onColumnFilter={(key) => controls.filterBy(key)}
        properties={controls.properties}
        locations={locationNames}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          purchaseOrderGroupLabel(
            grouping?.field ?? '',
            grouping?.granularity,
            key,
            options,
          )
        }
        collapsed={collapsed}
        onCollapsedChange={(id, closed) =>
          view.setDisplay({
            ...view.display,
            collapsedGroups: [
              ...view.display.collapsedGroups.filter(
                (item) => item !== `${groupPrefix}${id}`,
              ),
              ...(closed ? [`${groupPrefix}${id}`] : []),
            ].slice(-100),
          })
        }
        more={more}
      />
    ) : null;
  const body = (
    <div ref={rows} className="procurement-results">
      <CollectionBulkActions
        organizationId={organizationId}
        view={view}
        selected={selected}
        clear={() => setSelected([])}
      />
      {results ??
        (!data && list.isPending && !error ? <CollectionLoading /> : null)}
      {data && !grouping && data.items.length ? (
        <>
          <Pagination
            count={data.items.length}
            totalCount={data.totalCount ?? undefined}
            page={paging.page}
            pageSize={procurementPageSize}
            hasNext={!!paging.next}
            onPrevious={paging.previous}
            onNext={() => paging.next?.()}
            formatTotal={(count) =>
              m.procurement_list_orders_pagination_total({ count })
            }
            label={m.procurement_list_orders_pagination_label()}
          />
          {paging.first && !paging.previous ? (
            <Button variant="ghost" onClick={paging.first}>
              {m.procurement_list_first_page()}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <CollectionToolbar
        views={
          <>
            {tabs}
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="procurement"
              segmentLabel={purchaseOrderSegmentLabel}
              exportColumns={controls.columns.map((id) => ({
                id,
                label:
                  purchaseOrdersPresentation[id]?.label() ??
                  custom.find((field) => `custom:${field.id}` === id)?.label ??
                  id,
              }))}
            />
          </>
        }
        search={{
          value: search.q,
          onChange: (q) =>
            go({
              ...search,
              q: q || undefined,
              cursor: undefined,
              page: undefined,
            }),
          label: m.procurement_list_search_orders(),
          placeholder: m.procurement_list_search_orders_placeholder(),
          maxLength: 200,
          inputRef: searchInput,
        }}
        filters={controls.filters}
        conditions={controls.conditions}
        actions={
          <DescribedFilter
            organizationId={organizationId}
            domain="procurement"
            listName={m.procurement_list_view_orders()}
            fields={controls.conditions.fields}
            apply={(conditions) =>
              view.change({
                ...state,
                where: {
                  match: state.where.match,
                  conditions: [...state.where.conditions, ...conditions],
                },
              })
            }
          />
        }
        display={controls.display}
        sort={controls.sort}
        onClear={() => {
          keepQuery.current = false;
          controls.clearConditions();
          keepQuery.current = true;
        }}
        onRefresh={() => void list.refetch()}
        refreshing={list.isFetching}
        refreshLabel={m.procurement_list_refresh()}
      />
      <CollectionSummaryBand organizationId={organizationId} view={view} />
      <CollectionNotices
        offline={!online}
        error={error?.kind === 'invalid' ? error : listError}
        hasRows={hasRows}
        retry={() => void list.refetch()}
        firstPage={() => go({ ...search, cursor: undefined, page: undefined })}
        repair={repair}
      />
      {data?.groupsTruncated ? (
        <Alert role="status">{m.collections_groups_truncated()}</Alert>
      ) : null}
      {previewOn ? (
        <CollectionPreview
          className="procurement-preview-pane"
          open={!!open}
          list={body}
          preview={
            open ? (
              <PurchaseOrderPreview
                key={open}
                order={shown}
                locations={locationNames}
              />
            ) : null
          }
          label={m.procurement_preview_label()}
          title={shown?.reference}
          actions={
            open ? (
              <Link
                to="/app/$organizationId/procurement/$purchaseOrderId"
                params={{ organizationId, purchaseOrderId: open }}
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                aria-label={m.procurement_preview_open()}
                title={m.procurement_preview_open()}
              >
                <Maximize2 aria-hidden="true" />
              </Link>
            ) : null
          }
          onClose={() => setOpen(undefined)}
        />
      ) : (
        body
      )}
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[
          listShortcutGroup(
            previewOn
              ? shortcuts
              : shortcuts.filter((command) => command !== 'preview'),
          ),
        ]}
      />
    </>
  );
}
