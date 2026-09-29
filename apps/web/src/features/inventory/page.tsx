import './inventory.css';

import type { InventoryList, StockPosition } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Boxes, Search } from 'lucide-react';
import { useState } from 'react';

import { connectionsOptions } from '../connections/data';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { inventoryOptions, type InventorySearch } from './data';
import { stockFreshness, stockQuantity, StockState } from './presentation';

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
}) {
  const [draft, setDraft] = useState(search.q ?? '');
  const [shown, setShown] = useState(search.q);
  if (shown !== search.q) {
    setShown(search.q);
    setDraft(search.q ?? '');
  }
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
      header: 'SKU / location',
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
            {item.location} · {item.unit}
          </small>
          <StockState position={item} />
        </div>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (item: StockPosition) => (
        <div className="inventory-source-stack">
          {item.sources.map((source) => (
            <div key={source.connectionId}>
              <strong>{source.label}</strong>
              <small>
                {stockFreshness(source, list!.asOf)} · {source.status}
              </small>
            </div>
          ))}
        </div>
      ),
    },
    ...(['onHand', 'reserved', 'available', 'incoming'] as const).map(
      (field) => ({
        key: field,
        header: {
          onHand: 'On hand',
          reserved: 'Reserved',
          available: 'Available',
          incoming: 'Incoming',
        }[field],
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
                  {source.deleted ? '—' : stockQuantity(source[field])}
                </span>
                <small>
                  {field === 'available'
                    ? source.availabilityBasis === 'derived'
                      ? 'Derived'
                      : source.availabilityBasis === 'provider_reported'
                        ? 'Reported'
                        : 'Not reported'
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
      {from ? <Link to={from}>← Back to context</Link> : null}
      <PageHeader
        title="Inventory"
        icon={<DomainIcon domain="inventory" size="md" />}
        description="Know what is available, where it is, and why your sources disagree."
      />
      <CollectionToolbar
        refreshLabel="Refresh inventory"
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <div className="inventory-views">
            {(
              [
                ['all', 'All stock'],
                ['differs', 'Source differences'],
                ['unknown', 'Incomplete stock'],
              ] as const
            ).map(([view, label]) => (
              <Button
                key={view}
                variant="ghost"
                aria-pressed={(search.view ?? 'all') === view}
                onClick={() => update({ view })}
              >
                {label}
              </Button>
            ))}
          </div>
        }
        filters={(['skuId', 'locationId'] as const).flatMap((key) =>
          search[key]
            ? [
                {
                  key,
                  label: key === 'skuId' ? 'Selected SKU' : 'Selected location',
                  onRemove: () => update({ [key]: undefined }),
                },
              ]
            : [],
        )}
        onClear={() => change({})}
      >
        <form
          className="inventory-search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: draft.trim() || undefined });
          }}
        >
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search inventory"
            placeholder="Search SKU or location…"
            maxLength={120}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline" type="submit">
            Search
          </Button>
        </form>
        <Select
          aria-label="Inventory source"
          value={search.connectionId ?? ''}
          options={[
            { value: '', label: 'All sources' },
            ...sources.map((s) => ({ value: s.id, label: s.label })),
          ]}
          onValueChange={(value) =>
            update({ connectionId: value || undefined })
          }
        />
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft('');
              change({});
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </CollectionToolbar>
      <p className="inventory-note">
        One position per SKU, location and unit. Source quantities stay
        separate. Unknown means the source has not reported a value.
      </p>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh stock.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              Go to first page
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {list ? (
        <>
          <DataTable
            className="inventory-list-table"
            caption="Stock by SKU, location and source"
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.id}
            empty={
              <Empty>
                <Boxes size={30} aria-hidden="true" />
                <h2>
                  {filtered ? 'No stock matches' : 'No stock observed yet'}
                </h2>
                <p>
                  {filtered
                    ? 'Try another SKU, location or source.'
                    : 'Connect a source and map its SKUs and locations to see stock here.'}
                </p>
                {filtered ? (
                  <Button onClick={() => change({})} variant="outline">
                    Clear filters
                  </Button>
                ) : (
                  <Link
                    to="/app/$organizationId/apps"
                    params={{ organizationId }}
                  >
                    Connect a store or ERP
                  </Link>
                )}
              </Empty>
            }
          />
          <div className="inventory-pagination">
            <span>
              {list.items.length}{' '}
              {list.items.length === 1 ? 'position' : 'positions'} on this page
            </span>
            <div>
              {previous ? (
                <Button
                  variant="outline"
                  disabled={refreshing}
                  onClick={previous}
                >
                  Previous page
                </Button>
              ) : null}
              {search.cursor ? (
                <Button variant="ghost" onClick={() => update({})}>
                  First page
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={!list.nextCursor || refreshing}
                onClick={() =>
                  change({ ...search, cursor: list.nextCursor ?? undefined })
                }
              >
                Next page
              </Button>
            </div>
          </div>
        </>
      ) : loading && !error ? (
        <div className="inventory-loading" role="status">
          <span className="sr-only">Loading inventory…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
