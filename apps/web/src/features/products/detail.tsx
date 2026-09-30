import './products.css';

import type {
  CatalogField,
  CatalogListing,
  CatalogSource,
  ProductDetail,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, PackageX, RefreshCw } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { stockQuantity, StockState } from '../inventory/presentation';
import { recordReturnPath } from '../records/data';
import { IdentityLinks } from '../sync/identity-links';
import { productFilters, productOptions, type ProductsSearch } from './data';
import {
  catalogState,
  differenceSentence,
  fieldLabels,
  formatPrice,
  gapText,
  listingLabel,
  listingTitle,
  statusLabels,
} from './presentation';
import { SalesBars } from './sales';
import { SourceHeader } from './source-header';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

export type ProductError = 'missing' | 'unavailable';

/** Loads one SKU while keeping the catalog's filters and return context. */
export function ProductPage() {
  const { organizationId, skuId } = useParams({
    from: '/app/$organizationId/products/$skuId',
  });
  const search = useSearch({ from: '/app/$organizationId/products/$skuId' });
  const query = useQuery(productOptions(organizationId, skuId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <ProductDetailView
      organizationId={organizationId}
      search={search}
      detail={query.data}
      error={
        !query.error
          ? undefined
          : query.error instanceof IdentityError && query.error.status === 404
            ? 'missing'
            : 'unavailable'
      }
      loading={query.isPending}
      refreshing={query.isFetching}
      offline={!online}
      refresh={() => void query.refetch()}
      identity={
        query.data ? (
          <IdentityLinks
            organizationId={organizationId}
            entityId={query.data.item.skuId}
            onChanged={() => void query.refetch()}
          />
        ) : null
      }
    />
  );
}

type FieldRow = {
  key: string;
  label: string;
  field?: CatalogField;
  value: (listing: CatalogListing, source: CatalogSource) => ReactNode;
};

const fieldRows: FieldRow[] = [
  {
    key: 'title',
    label: 'Product',
    field: 'title',
    value: (listing) => listingTitle(listing),
  },
  {
    key: 'code',
    label: 'SKU code',
    value: (listing) => listing.code?.trim() || 'Not reported',
  },
  {
    key: 'status',
    label: 'Status',
    field: 'status',
    value: (listing) => statusLabels[listing.status],
  },
  {
    key: 'published',
    label: 'Sales channel',
    field: 'published',
    value: (listing, source) => listingLabel(listing.published, source.system),
  },
  {
    key: 'price',
    label: 'Price',
    field: 'price',
    value: (listing) => formatPrice(listing.price) ?? 'Not reported',
  },
  {
    key: 'barcode',
    label: 'Barcode',
    field: 'barcode',
    value: (listing) => listing.barcode ?? 'Not reported',
  },
  {
    key: 'vendor',
    label: 'Vendor',
    value: (listing) => listing.vendor ?? 'Not reported',
  },
  {
    key: 'ids',
    label: 'Source IDs',
    value: (listing) => (
      <span className="products-cell">
        <span>Product {listing.externalProduct ?? 'unknown'}</span>
        <small>SKU {listing.externalSku ?? 'unknown'}</small>
      </span>
    ),
  },
  {
    key: 'read',
    label: 'Freshness',
    value: (listing) => (
      <span className="products-cell">
        <span>
          Read <WorkspaceDate value={listing.observedAt} />
        </span>
        <small>
          Source updated{' '}
          {listing.sourceUpdatedAt ? (
            <WorkspaceDate value={listing.sourceUpdatedAt} />
          ) : (
            'unknown'
          )}
        </small>
      </span>
    ),
  },
];

/** Compares each source's listing field by field, with sources as columns. */
function ListingComparison({ detail }: { detail: ProductDetail }) {
  const { item } = detail;
  const shown = detail.sources.filter(
    (source) =>
      item.listings.some((l) => l.connectionId === source.connectionId) ||
      item.gaps.some((g) => g.connectionId === source.connectionId),
  );

  return (
    <DataTable
      className="products-comparison"
      caption="Listing comparison by source"
      rows={fieldRows}
      rowKey={(row) => row.key}
      columns={[
        {
          key: 'field',
          header: 'Field',
          cell: (row) => (
            <span className="products-field">
              {row.label}
              {row.field && item.differences.includes(row.field) ? (
                <Badge tone="warning">Differs</Badge>
              ) : null}
            </span>
          ),
        },
        ...shown.map((source) => ({
          key: source.connectionId,
          header: <SourceHeader source={source} />,
          cell: (row: FieldRow) => {
            const listing = item.listings.find(
              (l) => l.connectionId === source.connectionId,
            );
            if (!listing)
              return row.key === 'title' ? (
                <span className="products-muted">Not in catalog</span>
              ) : (
                <span className="products-muted" aria-label="Not listed">
                  —
                </span>
              );

            return (
              <span
                className={
                  row.field && item.differences.includes(row.field)
                    ? 'products-difference'
                    : undefined
                }
              >
                {row.value(listing, source)}
              </span>
            );
          },
        })),
      ]}
    />
  );
}

/** Explains each catalog gap and the next step a person can take. */
function Gaps({
  organizationId,
  detail,
  search,
}: {
  organizationId: string;
  detail: ProductDetail;
  search: ProductsSearch;
}) {
  if (!detail.item.gaps.length) return null;

  return (
    <section className="products-gaps" aria-labelledby="product-gaps">
      <h2 id="product-gaps">Not in every source</h2>
      {detail.item.gaps.map((gap) => {
        const source = detail.sources.find(
          (entry) => entry.connectionId === gap.connectionId,
        );

        return (
          <Alert key={gap.connectionId} tone={gap.match ? 'info' : 'neutral'}>
            <p>{gapText(gap, source, detail.asOf)}</p>
            {gap.match ? (
              <p className="products-gap-actions">
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: gap.match.skuId }}
                  search={search}
                >
                  Compare {gap.match.sku.trim()}
                </Link>
                <a href="#sku-sources">Review the link below</a>
              </p>
            ) : (
              <p className="products-muted">
                If it should be sold or managed there, add it in{' '}
                {source?.label ?? 'that source'}. Luma does not create listings.
              </p>
            )}
          </Alert>
        );
      })}
    </section>
  );
}

/** Shows one SKU across sources followed by the stock, demand, supply and issues that depend on it. */
export function ProductDetailView({
  organizationId,
  search = {},
  detail,
  error,
  loading = false,
  refreshing = false,
  offline = false,
  refresh,
  identity,
}: {
  organizationId: string;
  search?: ProductsSearch;
  detail?: ProductDetail | undefined;
  error?: ProductError | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  refresh: () => void;
  /** The sources behind this SKU and link controls. */
  identity?: ReactNode;
}) {
  const item = detail?.item;
  const from = recordReturnPath(organizationId, search.from);
  const state = detail && item ? catalogState(item, detail.sources) : null;
  const sourceLabel = (connectionId: string) =>
    detail?.sources.find((source) => source.connectionId === connectionId)
      ?.label ??
    detail?.stock
      .flatMap((position) => position.sources)
      .find((source) => source.connectionId === connectionId)?.label ??
    'Connected source';
  const orderSearch = item?.listings.find((l) => l.code)?.code?.trim();

  return (
    <main className="products-page">
      {from ? (
        <Link className="products-back" to={from}>
          <ArrowLeft size={14} />
          Back to context
        </Link>
      ) : (
        <Link
          className="products-back"
          to="/app/$organizationId/products"
          params={{ organizationId }}
          search={productFilters(search)}
        >
          <ArrowLeft size={14} />
          Back to products
        </Link>
      )}
      <PageHeader
        title={item?.sku.trim() ?? 'Product'}
        icon={<DomainIcon domain="products" size="md" />}
        description={
          item
            ? (item.title ?? 'No source reports a title for this SKU.')
            : 'Compare listings by source and see what depends on this SKU.'
        }
      />
      <div className="products-detail-toolbar">
        <span className="products-flags">
          {state ? (
            <StatePill state={state.state}>{state.label}</StatePill>
          ) : null}
          {item?.differences.map((field) => (
            <Badge key={field} tone="warning">
              {fieldLabels[field]}
            </Badge>
          ))}
        </span>
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          <RefreshCw size={14} />
          Refresh product
        </Button>
      </div>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh this product.
        </Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <PackageX size={30} aria-hidden="true" />
          <h2>SKU not found</h2>
          <p>
            This SKU does not exist in this workspace, or it was linked into
            another SKU.
          </p>
          <Link to="/app/$organizationId/products" params={{ organizationId }}>
            Browse products
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? 'This product could not be refreshed. The details below may be out of date.'
            : 'This product could not be loaded.'}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="products-loading" role="status">
          <span className="sr-only">Loading product…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {detail && item && error !== 'missing' ? (
        <>
          <section
            className="products-explanation"
            aria-labelledby="product-explanation"
          >
            <h2 id="product-explanation">
              {item.differences.length
                ? 'Same SKU. Different listings.'
                : !item.listings.length
                  ? 'No catalog lists this SKU'
                  : item.gaps.length
                    ? 'Listed in some sources only'
                    : 'How each source lists this SKU'}
            </h2>
            <p>
              {differenceSentence(item.differences) ??
                (item.listings.length
                  ? 'Known values agree where sources report them. Agreement does not establish which source is authoritative.'
                  : 'Luma knows this SKU from stock or order lines, but no connected catalog lists it.')}{' '}
              Titles are compared ignoring case, spacing and punctuation; prices
              only within the same currency.
            </p>
          </section>
          {item.listings.length ? <ListingComparison detail={detail} /> : null}
          <Gaps
            organizationId={organizationId}
            detail={detail}
            search={search}
          />
          <div className="products-context-grid">
            <Card className="products-section">
              <h2>Stock by location</h2>
              <p className="products-note">
                Available quantity per source. Sources are never added together.
              </p>
              <ul className="products-related">
                {detail.stock.map((position) => (
                  <li key={position.id}>
                    <Link
                      to="/app/$organizationId/inventory/$positionId"
                      params={{ organizationId, positionId: position.id }}
                    >
                      {position.location}
                    </Link>
                    <StockState position={position} />
                    <small>
                      {position.sources
                        .map(
                          (source) =>
                            `${source.label}: ${source.deleted ? 'removed' : stockQuantity(source.available)} ${position.unit}`,
                        )
                        .join(' · ')}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.stock.length ? (
                <p className="products-note">No stock observed for this SKU.</p>
              ) : null}
              <Link
                to="/app/$organizationId/inventory"
                params={{ organizationId }}
                search={{ skuId: item.skuId }}
              >
                Open in Inventory
              </Link>
            </Card>
            <Card className="products-section">
              <h2>Sales in the last 30 days</h2>
              <p className="products-note">
                Units ordered by placed date, net of reported cancellations.
                Shown per source, because systems can hold the same order.
              </p>
              {detail.sales.sources.map((sales) => (
                <SalesBars
                  key={`${sales.connectionId}:${sales.unit}`}
                  sales={sales}
                  since={detail.sales.since}
                  label={sourceLabel(sales.connectionId)}
                />
              ))}
              {!detail.sales.sources.length ? (
                <p className="products-note">
                  No orders with a placed date in the last 30 days.
                </p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>Orders with this SKU</h2>
              <p className="products-note">Open orders first.</p>
              <ul className="products-related">
                {detail.orders.map((order) => (
                  <li key={`${order.id}:${order.connectionId}:${order.unit}`}>
                    <Link
                      to="/app/$organizationId/orders/$orderId"
                      params={{ organizationId, orderId: order.id }}
                    >
                      {order.label}
                    </Link>
                    <span>
                      {order.quantity} {order.unit} · {order.status}
                    </span>
                    <small>
                      {sourceLabel(order.connectionId)}
                      {order.placedAt ? (
                        <>
                          {' · placed '}
                          <WorkspaceDate value={order.placedAt} />
                        </>
                      ) : null}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.orders.length ? (
                <p className="products-note">
                  No observed orders include this SKU.
                </p>
              ) : null}
              {orderSearch ? (
                <Link
                  to="/app/$organizationId/orders"
                  params={{ organizationId }}
                  search={{ q: orderSearch }}
                >
                  Search Orders for {orderSearch}
                </Link>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>Supply commitments</h2>
              <p className="products-note">
                Purchase order quantities are not confirmed incoming stock.
              </p>
              <ul className="products-related">
                {detail.purchaseOrders.map((order) => (
                  <li key={`${order.id}:${order.unit}`}>
                    <Link
                      to="/app/$organizationId/procurement/$purchaseOrderId"
                      params={{ organizationId, purchaseOrderId: order.id }}
                    >
                      {order.label}
                    </Link>
                    <span>
                      {order.quantity} {order.unit} · {order.status}
                    </span>
                  </li>
                ))}
              </ul>
              {!detail.purchaseOrders.length ? (
                <p className="products-note">
                  No purchase orders for this SKU.
                </p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>Issues</h2>
              <ul className="products-related">
                {detail.issues.map((issue) => (
                  <li key={issue.id}>
                    <Link
                      to="/app/$organizationId/exceptions/$exceptionId"
                      params={{ organizationId, exceptionId: issue.id }}
                      search={{ view: 'needs_you' }}
                    >
                      {issue.label}
                    </Link>
                    <span>{issue.state}</span>
                  </li>
                ))}
              </ul>
              {!detail.issues.length ? (
                <p className="products-note">
                  No recorded issues for this SKU or its stock.
                </p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>Other variants</h2>
              <p className="products-note">SKUs in the same source products.</p>
              <ul className="products-related">
                {detail.variants.map((variant) => (
                  <li key={`${variant.skuId}:${variant.connectionId}`}>
                    <Link
                      to="/app/$organizationId/products/$skuId"
                      params={{ organizationId, skuId: variant.skuId }}
                      search={search}
                    >
                      {variant.sku.trim()}
                    </Link>
                    <span>{statusLabels[variant.status]}</span>
                    <small>
                      {[variant.title, sourceLabel(variant.connectionId)]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.variants.length ? (
                <p className="products-note">
                  This SKU is the only variant of its products.
                </p>
              ) : null}
            </Card>
          </div>
          {detail.relatedTruncated ? (
            <Alert>
              Showing the first 50 entries per related record type. Open Orders,
              Inventory or Procurement to continue.
            </Alert>
          ) : null}
          <div id="sku-sources">{identity}</div>
          <section className="products-section">
            <h2>Listing history</h2>
            <p className="products-note">
              Catalog snapshots Luma read, newest first. A snapshot is evidence
              of a read, not necessarily a change at the source.
            </p>
            <DataTable
              caption="Listing observation history"
              rows={detail.history.entries}
              rowKey={(entry) => entry.id}
              columns={[
                {
                  key: 'time',
                  header: 'Read',
                  cell: (entry) => <WorkspaceDate value={entry.observedAt} />,
                },
                {
                  key: 'source',
                  header: 'Source',
                  cell: (entry) => (
                    <span className="products-cell">
                      <span>{sourceLabel(entry.connectionId)}</span>
                      <small>
                        {entry.deleted
                          ? 'Removed at source'
                          : entry.current
                            ? 'Current'
                            : 'Earlier read'}
                      </small>
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (entry) =>
                    entry.status ? statusLabels[entry.status] : '—',
                },
                {
                  key: 'published',
                  header: 'Sales channel',
                  hideOnNarrow: true,
                  cell: (entry) =>
                    entry.deleted
                      ? '—'
                      : listingLabel(
                          entry.published,
                          detail.sources.find(
                            (s) => s.connectionId === entry.connectionId,
                          )?.system ?? null,
                        ),
                },
                {
                  key: 'price',
                  header: 'Price',
                  numeric: true,
                  cell: (entry) => formatPrice(entry.price) ?? '—',
                },
              ]}
            />
            {detail.history.truncated ? (
              <p className="products-note">Showing the 50 most recent reads.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
