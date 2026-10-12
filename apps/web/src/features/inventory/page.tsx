import './inventory.css';

import type { InventoryList, StockPosition } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { unitOfMeasure } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Boxes, Plug } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { connectionStatusLabel } from '../../shared/orders/presentation';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import { inventoryOptions, type InventorySearch } from './data';
import {
  quantityLabels,
  stockFreshness,
  stockQuantity,
  StockState,
} from './presentation';

/** Connects the inventory list to workspace-scoped queries and shareable search state. */
export function InventoryPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inventory/',
  });
  const search = useSearch({ from: '/app/$organizationId/inventory/' });
  const navigate = useNavigate({ from: '/app/$organizationId/inventory/' });
  const query = useQuery(inventoryOptions(organizationId, search));
  const connections = useQuery(connectionsOptions(organizationId));
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const filterKey = JSON.stringify({ ...search, cursor: undefined });
  const trail = trails[filterKey] ?? [undefined];
  const index = trail.indexOf(search.cursor);
  const change = (next: InventorySearch) => {
    if (next.cursor && next.cursor === query.data?.nextCursor && index >= 0) {
      setTrails((previous) => ({
        ...previous,
        [filterKey]: [...trail.slice(0, index + 1), next.cursor],
      }));
    }
    void navigate({ search: next, resetScroll: false });
  };
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <InventoryView
      coverage={
        <SyncCoverage organizationId={organizationId} type="inventory" />
      }
      organizationId={organizationId}
      search={search}
      list={query.isError ? undefined : query.data}
      loading={query.isPending}
      error={query.error?.message}
      offline={query.isPaused}
      sources={connections.data?.map(({ id, label }) => ({ id, label })) ?? []}
      refreshing={query.isFetching}
      change={change}
      previous={
        index > 0
          ? () => change({ ...search, cursor: trail[index - 1] })
          : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

/** Presents separate source quantities in compact rows with search, comparison views and paging. */
export function InventoryView({
  organizationId,
  search,
  list,
  loading = false,
  error,
  offline = false,
  sources = [],
  refreshing = false,
  change,
  refresh,
  previous,
  coverage,
}: {
  organizationId: string;
  search: InventorySearch;
  list?: InventoryList | undefined;
  loading?: boolean;
  error?: string | undefined;
  offline?: boolean;
  sources?: { id: string; label: string }[];
  refreshing?: boolean;
  change: (search: InventorySearch) => void;
  refresh: () => void;
  previous?: (() => void) | undefined;
  /** Which sources the list covers. */
  coverage?: ReactNode;
}) {
  const update = (patch: Partial<InventorySearch>) =>
    change({ ...search, cursor: undefined, ...patch });
  const from = recordReturnPath(organizationId, search.from);
  const filtered = !!(
    search.q ||
    search.skuId ||
    search.locationId ||
    search.connectionId ||
    (search.view && search.view !== 'all')
  );
  const columns = [
    {
      key: 'sku',
      header: m.inventory_column_position(),
      cell: (item: StockPosition) => (
        <div className="inventory-cell">
          <Link
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: item.id }}
            search={search}
          >
            {item.sku}
          </Link>
          <small>
            {item.location} · {unitOfMeasure(item.unit)}
          </small>
          <StockState position={item} />
        </div>
      ),
    },
    {
      key: 'source',
      header: m.inventory_column_source(),
      cell: (item: StockPosition) => (
        <div className="inventory-source-stack">
          {item.sources.map((source) => (
            <div key={source.connectionId}>
              <strong>{source.label}</strong>
              {source.bundleContext ? (
                <small>{m.products_bundles_parent()}</small>
              ) : null}
              <small>
                {stockFreshness(source, list!.asOf)} ·{' '}
                {connectionStatusLabel(source.status)}
              </small>
            </div>
          ))}
        </div>
      ),
    },
    ...(['onHand', 'reserved', 'available', 'incoming'] as const).map(
      (field) => ({
        key: field,
        header: quantityLabels[field](),
        numeric: true,
        cell: (item: StockPosition) => (
          <div className="inventory-source-stack">
            {item.sources.map((source) => (
              <div
                key={source.connectionId}
                className={
                  item.differences.some((value) => value === field)
                    ? 'inventory-difference'
                    : ''
                }
              >
                <span>
                  {source.deleted
                    ? m.common_empty_value()
                    : stockQuantity(source[field])}
                </span>
                <small>
                  {field === 'available'
                    ? source.availabilityBasis === 'derived'
                      ? m.inventory_basis_derived()
                      : source.availabilityBasis === 'provider_reported'
                        ? m.inventory_basis_reported()
                        : m.common_not_reported()
                    : '\u00a0'}
                </small>
              </div>
            ))}
          </div>
        ),
      }),
    ),
  ];

  return (
    <main className="inventory-page">
      {from ? <Link to={from}>← {m.inventory_back_context()}</Link> : null}
      <PageTitle title={m.inventory_page_title()} />
      <Button
        variant="outline"
        render={
          <Link
            to="/app/$organizationId/inventory/transfers"
            params={{ organizationId }}
          />
        }
        nativeButton={false}
      >
        {m.inventory_transfer_nav()}
      </Button>
      <CollectionToolbar
        refreshLabel={m.inventory_list_refresh()}
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <CollectionViews
            label={m.inventory_list_views_label()}
            value={search.view ?? 'all'}
            views={[
              { value: 'all', label: m.inventory_view_all() },
              { value: 'differs', label: m.inventory_view_differs() },
              { value: 'unknown', label: m.inventory_view_unknown() },
            ]}
            onChange={(view) =>
              update({ view: view === 'all' ? undefined : view })
            }
          />
        }
        search={{
          value: search.q,
          onChange: (q) => update({ q }),
          label: m.inventory_list_search_label(),
          placeholder: m.inventory_list_search_placeholder(),
        }}
        filters={[
          {
            kind: 'choice',
            key: 'connectionId',
            label: m.inventory_filter_source(),
            icon: Plug,
            value: search.connectionId,
            options: [
              ...sources.map((s) => ({ value: s.id, label: s.label })),
              ...(search.connectionId &&
              !sources.some((s) => s.id === search.connectionId)
                ? [
                    {
                      value: search.connectionId,
                      label: m.inventory_selected_source(),
                    },
                  ]
                : []),
            ],
            onChange: (connectionId) => update({ connectionId }),
          },
          {
            kind: 'applied',
            key: 'skuId',
            label: m.inventory_filter_sku(),
            value: search.skuId
              ? (list?.items.find((item) => item.skuId === search.skuId)?.sku ??
                m.inventory_selected_sku())
              : undefined,
            onRemove: () => update({ skuId: undefined }),
          },
          {
            kind: 'applied',
            key: 'locationId',
            label: m.inventory_filter_location(),
            value: search.locationId
              ? (list?.items.find(
                  (item) => item.locationId === search.locationId,
                )?.location ?? m.inventory_selected_location())
              : undefined,
            onRemove: () => update({ locationId: undefined }),
          },
        ]}
        onClear={() => change({ view: search.view, from: search.from })}
      />
      {coverage}
      <p className="inventory-note">{m.inventory_list_note()}</p>
      {offline ? <Alert role="status">{m.inventory_offline()}</Alert> : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {m.inventory_list_load_failed()} {error}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.inventory_list_first_page_button()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {list ? (
        <>
          <DataTable
            className="inventory-list-table"
            caption={m.inventory_list_caption()}
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.id}
            empty={
              <Empty>
                <Boxes size={30} aria-hidden="true" />
                <h2>
                  {filtered
                    ? m.inventory_list_unmatched_title()
                    : m.inventory_list_empty_title()}
                </h2>
                <p>
                  {filtered
                    ? m.inventory_list_unmatched_body()
                    : m.inventory_list_empty_body()}
                </p>
                {filtered ? (
                  <Button onClick={() => change({})} variant="outline">
                    {m.common_clear_filters()}
                  </Button>
                ) : (
                  <Link
                    to="/app/$organizationId/apps"
                    params={{ organizationId }}
                  >
                    {m.inventory_list_connect()}
                  </Link>
                )}
              </Empty>
            }
          />
          <div className="inventory-pagination">
            <span>{m.inventory_list_count({ count: list.items.length })}</span>
            <div>
              {previous ? (
                <Button variant="outline" onClick={previous}>
                  {m.inventory_list_previous()}
                </Button>
              ) : null}
              {search.cursor ? (
                <Button variant="ghost" onClick={() => update({})}>
                  {m.inventory_list_first_page()}
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={!list.nextCursor}
                onClick={() =>
                  change({ ...search, cursor: list.nextCursor ?? undefined })
                }
              >
                {m.inventory_list_next()}
              </Button>
            </div>
          </div>
        </>
      ) : loading && !error ? (
        <div className="inventory-loading" role="status">
          <span className="sr-only">{m.inventory_list_loading()}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
