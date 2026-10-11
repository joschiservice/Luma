import './products.css';

import type {
  CatalogItem,
  CatalogSource,
  CatalogView,
  ProductList,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  type CollectionFilterOption,
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Package, PackageCheck, PackageX } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
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

/** Lists catalog sources as filter options, keeping a selected source that the page no longer lists. */
function sourceOptions(
  sources: CatalogSource[],
  selected: string | undefined,
): CollectionFilterOption[] {
  const options = sources.map((source) => ({
    value: source.connectionId,
    label: source.label,
  }));

  return selected && !options.some((option) => option.value === selected)
    ? [...options, { value: selected, label: m.products_source_selected() }]
    : options;
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
        <span>{m.products_listing_not_in_catalog()}</span>
        {gap?.match ? (
          <Link
            to="/app/$organizationId/products/$skuId"
            params={{ organizationId, skuId: gap.match.skuId }}
            search={search}
          >
            {m.products_listing_same_code({ sku: gap.match.sku.trim() })}
          </Link>
        ) : (
          <small>
            {source.fullReadAt
              ? m.products_listing_full_read()
              : m.products_listing_full_unread()}
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
        {formatPrice(listing.price) ?? m.products_listing_no_price()}
      </span>
      <small className={differs('published')}>
        {listingLabel(listing.published, source.system)}
      </small>
      <small>
        {readAge(listing.observedAt, asOf)}
        {listings.length > 1
          ? ` · ${m.products_listing_in_products({ count: listings.length })}`
          : ''}
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
      header: m.products_column_sku(),
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
            <small>{item.title ?? m.products_no_title()}</small>
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
  const update = (patch: Partial<ProductsSearch>) =>
    change({ ...productFilters(search), from: search.from, ...patch });
  const clear = () => change({ from: search.from });
  const from = recordReturnPath(organizationId, search.from);
  const view = search.view ?? 'all';
  const shownList = list ?? stale;
  const sources = shownList?.sources ?? [];
  const filtered = !!(
    search.q ||
    search.connectionId ||
    search.missingFrom ||
    view !== 'all'
  );
  const views: CatalogView[] = ['all', 'differs', 'missing', 'unlinked'];

  return (
    <main className="products-page">
      {from ? <Link to={from}>← {m.products_back_context()}</Link> : null}
      <PageTitle title={m.products_page_title()} />
      <CollectionToolbar
        refreshLabel={m.products_list_refresh()}
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <CollectionViews
            label={m.products_list_views_label()}
            value={view}
            views={views.map((option) => ({
              value: option,
              label: viewLabels[option],
              description: viewDescriptions[option],
              count: shownList?.counts[option],
              attention: option !== 'all',
            }))}
            onChange={(option) => update({ view: option })}
          />
        }
        search={{
          value: search.q,
          onChange: (q) => update({ q }),
          label: m.products_list_search_label(),
          placeholder: m.products_list_search_placeholder(),
        }}
        filters={[
          {
            kind: 'choice',
            key: 'connectionId',
            label: m.products_filter_listed_in(),
            icon: PackageCheck,
            value: search.connectionId,
            options: sourceOptions(sources, search.connectionId),
            onChange: (connectionId) => update({ connectionId }),
          },
          {
            kind: 'choice',
            key: 'missingFrom',
            label: m.products_filter_missing_from(),
            icon: PackageX,
            value: search.missingFrom,
            options:
              sources.length > 1 || search.missingFrom
                ? sourceOptions(sources, search.missingFrom)
                : [],
            onChange: (missingFrom) => update({ missingFrom }),
          },
        ]}
        onClear={() => change({ from: search.from, view: search.view })}
      />
      {coverage}
      <p className="products-note">{m.products_list_note()}</p>
      {offline ? (
        <Alert role="status">{m.products_list_offline()}</Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? m.products_list_refresh_failed()
            : `${m.products_list_load_failed()} ${error}`}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.products_list_first_page_button()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {shownList ? (
        <>
          <DataTable
            className="products-list-table"
            caption={m.products_list_caption({ view: viewLabels[view] })}
            columns={catalogColumns(organizationId, search, shownList)}
            rows={shownList.items}
            rowKey={(item) => item.skuId}
            empty={
              <Empty>
                <Package size={30} aria-hidden="true" />
                <h2>
                  {filtered
                    ? m.products_list_unmatched_title()
                    : m.products_list_empty_title()}
                </h2>
                <p>
                  {filtered
                    ? view !== 'all' && !search.q
                      ? m.products_list_view_empty({ view: viewLabels[view] })
                      : m.products_list_unmatched_body()
                    : m.products_list_empty_body()}
                </p>
                {filtered ? (
                  <Button onClick={clear} variant="outline">
                    {m.common_clear_filters()}
                  </Button>
                ) : (
                  <Link
                    to="/app/$organizationId/sync"
                    params={{ organizationId }}
                  >
                    {m.products_open_data_sync()}
                  </Link>
                )}
              </Empty>
            }
          />
          <div className="products-pagination">
            <span>
              {(search.cursor
                ? m.products_list_count_page
                : m.products_list_count)({
                shown: shownList.items.length,
                total: shownList.counts[view] ?? shownList.items.length,
              })}
            </span>
            <div>
              {previous ? (
                <Button variant="outline" onClick={previous}>
                  {m.products_list_previous()}
                </Button>
              ) : null}
              {search.cursor ? (
                <Button variant="ghost" onClick={() => update({})}>
                  {m.products_list_first_page()}
                </Button>
              ) : null}
              <Button variant="outline" disabled={!next} onClick={next}>
                {m.products_list_next()}
              </Button>
            </div>
          </div>
        </>
      ) : loading && !error ? (
        <div className="products-loading" role="status">
          <span className="sr-only">{m.products_list_loading()}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
