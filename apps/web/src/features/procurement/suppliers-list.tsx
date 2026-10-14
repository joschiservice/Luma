import {
  collectionField,
  collectionWhereIssues,
  suppliersCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { selectRange } from '@luma/ui/lib/row-selection';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, Building2 } from 'lucide-react';
import { type ReactNode, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
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
import type { CollectionSearch } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import {
  adaptiveAvailabilityOptions,
  customFieldsOptions,
  customFieldValuesOptions,
} from '../adaptive/data';
import { customFieldColumns, customFieldText } from '../adaptive/presentation';
import { supplierSegmentLabel, suppliersPresentation } from './collection';
import {
  procurementPageSize,
  type ProcurementSearch,
  supplierListQuery,
  suppliersOptions,
} from './data';
import { type ListedSupplier, supplierField } from './fields';

/** The list commands the supplier list handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'open',
  'toggle-selection',
  'extend-selection',
  'escape',
  'search',
  'filter',
  'help',
];

const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  name: { width: 240 },
  link: { hideOnNarrow: true },
  references: { hideOnNarrow: true, width: 220 },
  created: { hideOnNarrow: true },
  orders: { numeric: true },
};

/**
 * The supplier list of the procurement page as a configurable table: the member's view with its
 * conditions and sort, the view bar, list keys and keyset paging. Each row offers its purchase
 * orders, which opens the order list filtered to that supplier. Readable custom fields show as
 * columns and can filter and sort the list.
 */
export function SuppliersList({
  organizationId,
  search,
  tabs,
  empty,
}: {
  organizationId: string;
  search: ProcurementSearch;
  /** The procurement page's list tabs, shown before the view menu. */
  tabs: ReactNode;
  /** Shown while the workspace has no suppliers; the list explains filtered results. */
  empty: ReactNode;
}) {
  const navigate = useNavigate({ from: '/app/$organizationId/procurement/' });
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: ProcurementSearch) =>
    void navigate({ search: next, resetScroll: false });
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: suppliersCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        tab: 'suppliers',
        ...(keepQuery.current && search.q ? { q: search.q } : {}),
        ...next,
      } as ProcurementSearch),
  });
  const state = view.state;
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const fields = useQuery({
    ...customFieldsOptions(organizationId, 'supplier'),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  const custom = customFieldColumns(fields.data ?? []);
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
    ? collectionWhereIssues(suppliersCatalog, state.where, {
        customFieldTypes: new Map(
          custom
            .filter((field) => !field.archived)
            .map((field) => [field.id, field.type]),
        ),
      })
    : [];
  const query = supplierListQuery(state, search, timeZone);
  const list = useQuery({
    ...suppliersOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const controls = useCollectionControls({
    view,
    catalog: suppliersCatalog,
    presentation: suppliersPresentation,
    can,
    custom,
    required: ['name'],
    title: 'name',
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  // A 403 for a reader who can read suppliers means a custom field the view uses is closed to
  // them.
  const fieldDenied =
    list.error instanceof IdentityError &&
    list.error.status === 403 &&
    can('procurement.read');
  const issues = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repairedState(suppliersCatalog, state, issues, can))
    : undefined;
  const error: CollectionError | undefined =
    clientIssues.length || fieldDenied
      ? { kind: 'invalid', message: m.collections_needs_repair() }
      : collectionError(list.error, search.cursor);
  const data = list.data;
  const keys = (data?.items ?? []).map((row) => row.id);
  const customShown = custom.filter((field) =>
    controls.columns.includes(`custom:${field.id}`),
  );
  const customValues = useQuery({
    ...customFieldValuesOptions(organizationId, 'supplier', keys),
    enabled: customShown.length > 0 && keys.length > 0,
  });
  const paging = useCursorPaging({
    key: JSON.stringify([
      organizationId,
      'suppliers',
      view.key,
      query.where,
      query.sort,
      query.direction,
      query.q,
    ]),
    cursor: search.cursor,
    page: search.page,
    nextCursor: data?.nextCursor,
    go: ({ cursor, page }) => go({ ...search, cursor, page }),
  });

  const searchInput = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
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
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    onOpen: (index) => {
      const supplierId = keys[index];
      if (supplierId)
        void navigate({
          to: '/app/$organizationId/procurement/suppliers/$supplierId',
          params: { organizationId, supplierId },
        });
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

  if (list.error instanceof IdentityError && list.error.status === 401)
    return <SignInRedirect />;

  // The supplier's purchase orders: the order list with one supplier condition.
  const showOrders = (supplier: ListedSupplier) =>
    go({
      view: 'all',
      where: {
        match: 'all',
        conditions: [{ field: 'supplier', op: 'any_of', value: [supplier.id] }],
      },
    });
  const columns: DataTableColumn<ListedSupplier>[] = [
    ...Object.entries(layout).map(([key, options]) => {
      const field = collectionField(suppliersCatalog, key);

      return {
        key,
        header: suppliersPresentation[key]?.label() ?? key,
        ...options,
        ...(field?.sort ? { sortKey: key } : {}),
        filterable: !!field?.filter,
        cell:
          key === 'name'
            ? (supplier: ListedSupplier) => (
                <DataTableRowLink
                  render={
                    <Link
                      to="/app/$organizationId/procurement/suppliers/$supplierId"
                      params={{ organizationId, supplierId: supplier.id }}
                    />
                  }
                >
                  {supplier.name}
                </DataTableRowLink>
              )
            : key === 'orders'
              ? (supplier: ListedSupplier) => (
                  <span className="procurement-supplier-orders">
                    {supplierField(supplier, key)}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={m.procurement_list_show_supplier_orders({
                        supplier: supplier.name,
                      })}
                      title={m.procurement_list_show_orders()}
                      onClick={() => showOrders(supplier)}
                    >
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </Button>
                  </span>
                )
              : (supplier: ListedSupplier) => supplierField(supplier, key),
      };
    }),
    ...customShown.map((field) => ({
      key: `custom:${field.id}`,
      header: field.label,
      hideOnNarrow: true as const,
      cell: (supplier: ListedSupplier) =>
        field.archived
          ? m.collections_field_archived()
          : customFieldText(
              field,
              customValues.data?.values.find(
                (value) =>
                  value.recordId === supplier.id && value.fieldId === field.id,
              )?.value,
            ),
    })),
  ];
  const clear = () => {
    keepQuery.current = false;
    view.reset();
    keepQuery.current = true;
  };
  const filtered = !!search.q || state.where.conditions.length > 0;
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  const viewName = view.saved?.name ?? supplierSegmentLabel();
  const sortLabel = state.sort
    ? (suppliersPresentation[state.sort.field]?.label() ??
      custom.find((field) => `custom:${field.id}` === state.sort?.field)
        ?.label ??
      state.sort.field)
    : '';

  return (
    <>
      <CollectionToolbar
        views={
          <>
            {tabs}
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="procurement?tab=suppliers"
              segmentLabel={supplierSegmentLabel}
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
          label: m.procurement_list_search_suppliers(),
          placeholder: m.procurement_list_search_suppliers_placeholder(),
          maxLength: 200,
          inputRef: searchInput,
        }}
        filters={controls.filters}
        conditions={controls.conditions}
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
      <CollectionNotices
        offline={!online}
        error={error?.kind === 'invalid' ? error : listError}
        hasRows={!!data?.items.length}
        retry={() => void list.refetch()}
        firstPage={() => go({ ...search, cursor: undefined, page: undefined })}
        repair={repair}
      />
      <div ref={rows} className="procurement-results">
        <CollectionBulkActions
          organizationId={organizationId}
          view={view}
          selected={selected}
          clear={() => setSelected([])}
        />
        {data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
          data.items.length ? (
            <>
              <DataTable
                caption={m.procurement_list_caption({
                  view: viewName,
                  sort: sortLabel,
                })}
                columns={columns}
                rows={data.items}
                rowKey={(supplier) => supplier.id}
                rowHeader="name"
                empty={null}
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
                firstSortDirection="asc"
                columnState={controls.columnState}
                onColumnStateChange={controls.onColumnStateChange}
                onColumnFilter={(key) => controls.filterBy(key)}
                density={state.density}
                focusedRowKey={keyboard.focusedKey}
                selection={{
                  selected,
                  onChange: setSelected,
                  rowLabel: (supplier) => supplier.name,
                }}
              />
              <Pagination
                count={data.items.length}
                totalCount={data.totalCount ?? undefined}
                page={paging.page}
                pageSize={procurementPageSize}
                hasNext={!!paging.next}
                onPrevious={paging.previous}
                onNext={() => paging.next?.()}
                formatTotal={(count) =>
                  m.procurement_list_suppliers_pagination_total({ count })
                }
                label={m.procurement_list_suppliers_pagination_label()}
              />
              {paging.first && !paging.previous ? (
                <Button variant="ghost" onClick={paging.first}>
                  {m.procurement_list_first_page()}
                </Button>
              ) : null}
            </>
          ) : filtered ? (
            <Empty>
              <Building2 size={30} aria-hidden="true" />
              <h3>{m.procurement_list_suppliers_filtered_title()}</h3>
              <p>{m.procurement_list_suppliers_filtered_body()}</p>
              <Button variant="outline" onClick={clear}>
                {m.common_clear_filters()}
              </Button>
            </Empty>
          ) : (
            empty
          )
        ) : !data && list.isPending && !error ? (
          <CollectionLoading />
        ) : null}
      </div>
      <ShortcutHelp
        open={help}
        onOpenChange={setHelp}
        groups={[listShortcutGroup(shortcuts)]}
      />
    </>
  );
}
