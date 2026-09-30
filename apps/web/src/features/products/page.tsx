import './products.css';

import type {
  CatalogItem,
  CatalogSource,
  CatalogView,
  ProductList,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Package, Search } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import { productFilters, productsOptions, type ProductsSearch } from './data';
import {
  catalogState,
  fieldLabels,
  formatPrice,
  listingLabel,
  listingTitle,
  readAge,
  statusLabels,
  viewDescriptions,
  viewLabels,
} from './presentation';
import { SourceHeader } from './source-header';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Connects the product catalog to workspace-scoped queries and shareable URL filters. */
export function ProductsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/products/',
  });
  const search = useSearch({ from: '/app/$organizationId/products/' });
  const navigate = useNavigate({ from: '/app/$organizationId/products/' });
  const query = useQuery(productsOptions(organizationId, search));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const filterKey = JSON.stringify(productFilters(search));
  const trail = trails[filterKey] ?? [undefined];
  const index = trail.indexOf(search.cursor);
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const change = (next: ProductsSearch) =>
    void navigate({ search: next, resetScroll: false });

  return (
    <ProductsView
      coverage={
        <SyncCoverage organizationId={organizationId} type="products" />
      }
      organizationId={organizationId}
      search={search}
      list={query.isError ? undefined : query.data}
      stale={query.isError ? query.data : undefined}
      loading={query.isPending}
      error={query.error?.message}
      offline={!online}
      refreshing={query.isFetching}
      change={change}
      next={
        query.data?.nextCursor
          ? () => {
              const cursor = query.data.nextCursor!;
              if (index >= 0)
                setTrails((previous) => ({
                  ...previous,
                  [filterKey]: [...trail.slice(0, index + 1), cursor],
                }));
              change({ ...search, cursor });
            }
          : undefined
      }
      previous={
        index > 0
          ? () => change({ ...search, cursor: trail[index - 1] })
          : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

/** Shows one source's listing of a SKU, or why the source has none. */
function ListingCell({
  organizationId,
  item,
  source,
  asOf,
  search,
}: {
  organizationId: string;
  item: CatalogItem;
  source: CatalogSource;
  asOf: string;
  search: ProductsSearch;
}) {
  const listings = item.listings.filter(
    (listing) => listing.connectionId === source.connectionId,
  );
  const differs = (field: keyof typeof fieldLabels) =>
    item.differences.includes(field) ? 'products-difference' : undefined;
  const listing = listings[0];
  if (!listing) {
    const gap = item.gaps.find(
      (entry) => entry.connectionId === source.connectionId,
    );

    return (
      <div className="products-listing products-listing-gap">
        <span>Not in catalog</span>
        {gap?.match ? (
          <Link
            to="/app/$organizationId/products/$skuId"
            params={{ organizationId, skuId: gap.match.skuId }}
            search={search}
          >
            Same code, not linked: {gap.match.sku.trim()}
          </Link>
        ) : (
          <small>
            {source.fullReadAt
              ? 'Full catalog read'
              : 'Full catalog not read yet'}
          </small>
        )}
      </div>
    );
  }

  return (
    <div className="products-listing">
      {item.differences.includes('title') ? (
        <span className={differs('title')}>{listingTitle(listing)}</span>
      ) : null}
      <span className={differs('status')}>{statusLabels[listing.status]}</span>
      <span className={differs('price')}>
        {formatPrice(listing.price) ?? 'No price reported'}
      </span>
      <small className={differs('published')}>
        {listingLabel(listing.published, source.system)}
      </small>
      <small>
        {readAge(listing.observedAt, asOf)}
        {listings.length > 1 ? ` · in ${listings.length} products` : ''}
      </small>
    </div>
  );
}

function catalogColumns(
  organizationId: string,
  search: ProductsSearch,
  list: ProductList,
): DataTableColumn<CatalogItem>[] {
  return [
    {
      key: 'sku',
      header: 'SKU / product',
      cell: (item) => {
        const state = catalogState(item, list.sources);

        return (
          <div className="products-cell">
            <DataTableRowLink
              render={
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: item.skuId }}
                  search={search}
                />
              }
            >
              {item.sku.trim()}
            </DataTableRowLink>
            <small>{item.title ?? 'No title reported'}</small>
            <span className="products-flags">
              <StatePill state={state.state}>{state.label}</StatePill>
              {item.differences.map((field) => (
                <Badge key={field} tone="warning">
                  {fieldLabels[field]}
                </Badge>
              ))}
            </span>
          </div>
        );
      },
    },
    ...list.sources.map((source) => ({
      key: source.connectionId,
      header: <SourceHeader source={source} />,
      cell: (item: CatalogItem) => (
        <ListingCell
          organizationId={organizationId}
          item={item}
          source={source}
          asOf={list.asOf}
          search={search}
        />
      ),
    })),
  ];
}

/** Presents the catalog with one column per source, comparison views, search and paging. */
export function ProductsView({
  organizationId,
  search,
  list,
  stale,
  loading = false,
  error,
  offline = false,
  refreshing = false,
  change,
  refresh,
  next,
  previous,
  coverage,
}: {
  organizationId: string;
  search: ProductsSearch;
  list?: ProductList | undefined;
  /** The last loaded page, shown read-only after a failed refresh. */
  stale?: ProductList | undefined;
  loading?: boolean;
  error?: string | undefined;
  offline?: boolean;
  refreshing?: boolean;
  change: (search: ProductsSearch) => void;
  refresh: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
  /** Which sources the list covers. */
  coverage?: ReactNode;
}) {
  const [draft, setDraft] = useState(search.q ?? '');
  const [shown, setShown] = useState(search.q);
  if (shown !== search.q) {
    setShown(search.q);
    setDraft(search.q ?? '');
  }
  const update = (patch: Partial<ProductsSearch>) =>
    change({ ...productFilters(search), from: search.from, ...patch });
  const clear = () => {
    setDraft('');
    change({ from: search.from });
  };
  const from = recordReturnPath(organizationId, search.from);
  const view = search.view ?? 'all';
  const shownList = list ?? stale;
  const sources = shownList?.sources ?? [];
  const sourceLabel = (id: string | undefined) =>
    sources.find((source) => source.connectionId === id)?.label ??
    'Selected source';
  const filtered = !!(
    search.q ||
    search.connectionId ||
    search.missingFrom ||
    view !== 'all'
  );
  const views: CatalogView[] = ['all', 'differs', 'missing', 'unlinked'];

  return (
    <main className="products-page">
      {from ? <Link to={from}>← Back to context</Link> : null}
      <PageHeader
        title="Products"
        icon={<DomainIcon domain="products" size="md" />}
        description="See how each SKU is listed in your store and ERP, and find listings that are missing or disagree."
      />
      <CollectionToolbar
        refreshLabel="Refresh products"
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <div className="products-views" role="group" aria-label="Views">
            {views.map((option) => (
              <Button
                key={option}
                variant="ghost"
                aria-pressed={view === option}
                onClick={() => update({ view: option })}
              >
                {viewLabels[option]}
                {shownList ? (
                  <Badge
                    tone={
                      option !== 'all' && shownList.counts[option]
                        ? 'warning'
                        : 'neutral'
                    }
                  >
                    {shownList.counts[option]}
                  </Badge>
                ) : null}
              </Button>
            ))}
          </div>
        }
        filters={[
          ...(search.q
            ? [
                {
                  key: 'q',
                  label: `Search: ${search.q}`,
                  onRemove: () => update({ q: undefined }),
                },
              ]
            : []),
          ...(search.connectionId
            ? [
                {
                  key: 'connectionId',
                  label: `Listed in ${sourceLabel(search.connectionId)}`,
                  onRemove: () => update({ connectionId: undefined }),
                },
              ]
            : []),
          ...(search.missingFrom
            ? [
                {
                  key: 'missingFrom',
                  label: `Not in ${sourceLabel(search.missingFrom)}`,
                  onRemove: () => update({ missingFrom: undefined }),
                },
              ]
            : []),
        ]}
        onClear={clear}
      >
        <form
          className="products-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: draft.trim() || undefined });
          }}
        >
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search products"
            placeholder="SKU, title, barcode, vendor or source ID…"
            maxLength={120}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline" type="submit">
            Search
          </Button>
        </form>
        <Select
          aria-label="Listed in"
          value={search.connectionId ?? ''}
          options={[
            { value: '', label: 'Listed in: any source' },
            ...sources.map((source) => ({
              value: source.connectionId,
              label: `Listed in ${source.label}`,
            })),
          ]}
          onValueChange={(value) =>
            update({ connectionId: value || undefined })
          }
        />
        {sources.length > 1 ? (
          <Select
            aria-label="Missing from"
            value={search.missingFrom ?? ''}
            options={[
              { value: '', label: 'Missing from: no filter' },
              ...sources.map((source) => ({
                value: source.connectionId,
                label: `Not in ${source.label}`,
              })),
            ]}
            onValueChange={(value) =>
              update({ missingFrom: value || undefined })
            }
          />
        ) : null}
        {filtered ? (
          <Button variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </CollectionToolbar>
      <p className="products-note">
        {viewDescriptions[view]} No source is treated as the authority. Prices
        are compared only within the same currency.
      </p>
      {coverage}
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh products.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? 'Products could not be refreshed. The list below may be out of date.'
            : error}{' '}
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
      {shownList ? (
        <>
          <DataTable
            className="products-list-table"
            caption={`${viewLabels[view]}, with each source’s listing side by side`}
            columns={catalogColumns(organizationId, search, shownList)}
            rows={shownList.items}
            rowKey={(item) => item.skuId}
            empty={
              <Empty>
                <Package size={30} aria-hidden="true" />
                <h2>
                  {filtered ? 'No products match' : 'No products imported yet'}
                </h2>
                <p>
                  {filtered
                    ? view !== 'all' && !search.q
                      ? `No SKUs in “${viewLabels[view]}”. Your catalogs agree on this view.`
                      : 'Try another SKU, title or source.'
                    : 'Products appear here once a connected store or ERP shares its catalog. Check Data sync for progress.'}
                </p>
                {filtered ? (
                  <Button onClick={clear} variant="outline">
                    Clear filters
                  </Button>
                ) : (
                  <Link
                    to="/app/$organizationId/sync"
                    params={{ organizationId }}
                  >
                    Open Data sync
                  </Link>
                )}
              </Empty>
            }
          />
          <div className="products-pagination">
            <span>
              {shownList.items.length} of {shownList.counts[view]}{' '}
              {shownList.counts[view] === 1 ? 'SKU' : 'SKUs'}
              {search.cursor ? ' on this page' : ''}
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
                disabled={!next || refreshing}
                onClick={next}
              >
                Next page
              </Button>
            </div>
          </div>
        </>
      ) : loading && !error ? (
        <div className="products-loading" role="status">
          <span className="sr-only">Loading products…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
