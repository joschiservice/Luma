import './products.css';

import type {
  CatalogField,
  CatalogListing,
  CatalogSource,
  ProductDetail,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { quantityUnit } from '@luma/ui/lib/units';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { PackageX } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { stockQuantity, StockState } from '../inventory/presentation';
import {
  formatSourceNumber,
  issueStateLabel,
  purchaseOrderLabels,
  statusLabels as orderStatusLabels,
} from '../orders/presentation';
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
  label: () => string;
  field?: CatalogField;
  value: (listing: CatalogListing, source: CatalogSource) => ReactNode;
};

const fieldRows: FieldRow[] = [
  {
    key: 'title',
    label: m.products_detail_field_product,
    field: 'title',
    value: (listing) => listingTitle(listing),
  },
  {
    key: 'code',
    label: m.products_detail_field_code,
    value: (listing) => listing.code?.trim() || m.common_not_reported(),
  },
  {
    key: 'status',
    label: m.products_field_status,
    field: 'status',
    value: (listing) => statusLabels[listing.status],
  },
  {
    key: 'published',
    label: m.products_field_published,
    field: 'published',
    value: (listing, source) => listingLabel(listing.published, source.system),
  },
  {
    key: 'price',
    label: m.products_field_price,
    field: 'price',
    value: (listing) => formatPrice(listing.price) ?? m.common_not_reported(),
  },
  {
    key: 'barcode',
    label: m.products_field_barcode,
    field: 'barcode',
    value: (listing) => listing.barcode ?? m.common_not_reported(),
  },
  {
    key: 'vendor',
    label: m.products_detail_field_vendor,
    value: (listing) => listing.vendor ?? m.common_not_reported(),
  },
  {
    key: 'ids',
    label: m.products_detail_field_ids,
    value: (listing) => (
      <span className="products-cell">
        <span>
          {listing.externalProduct
            ? m.products_detail_product_id({ id: listing.externalProduct })
            : m.products_detail_product_id_missing()}
        </span>
        <small>
          {listing.externalSku
            ? m.products_detail_sku_id({ id: listing.externalSku })
            : m.products_detail_sku_id_missing()}
        </small>
      </span>
    ),
  },
  {
    key: 'read',
    label: m.products_detail_field_freshness,
    value: (listing) => (
      <span className="products-cell">
        <span>
          {rich(m.products_detail_last_read, {
            date: <WorkspaceDate value={listing.observedAt} />,
          })}
        </span>
        <small>
          {listing.sourceUpdatedAt
            ? rich(m.products_detail_source_updated, {
                date: <WorkspaceDate value={listing.sourceUpdatedAt} />,
              })
            : m.products_detail_source_updated_missing()}
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
      caption={m.products_detail_comparison_caption()}
      rows={fieldRows}
      rowKey={(row) => row.key}
      columns={[
        {
          key: 'field',
          header: m.products_detail_field(),
          cell: (row) => (
            <span className="products-field">
              {row.label()}
              {row.field && item.differences.includes(row.field) ? (
                <Badge tone="warning">{m.products_detail_differs()}</Badge>
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
                <span className="products-muted">
                  {m.products_listing_not_in_catalog()}
                </span>
              ) : (
                <span
                  className="products-muted"
                  aria-label={m.products_detail_not_listed()}
                >
                  {m.common_empty_value()}
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
      <h2 id="product-gaps">{m.products_gaps_title()}</h2>
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
                  {m.products_gaps_compare({ sku: gap.match.sku.trim() })}
                </Link>
                <a href="#sku-sources">{m.products_gaps_review_link()}</a>
              </p>
            ) : (
              <p className="products-muted">
                {source
                  ? m.products_gaps_add({ source: source.label })
                  : m.products_gaps_add_generic()}
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
    m.orders_source_fallback();
  const orderSearch = item?.listings.find((l) => l.code)?.code?.trim();

  return (
    <div className="products-page">
      <RecordHeader
        section={{
          label: m.products_page_title(),
          domain: 'products',
          link: (
            <Link
              to="/app/$organizationId/products"
              params={{ organizationId }}
              search={productFilters(search)}
            />
          ),
        }}
        title={item?.sku.trim() ?? m.products_detail_title_fallback()}
        back={from ? <Link to={from} /> : undefined}
        actions={
          <RefreshButton refreshing={refreshing} onClick={refresh}>
            {m.products_detail_refresh()}
          </RefreshButton>
        }
        status={
          <>
            {state ? (
              <StatePill state={state.state}>{state.label}</StatePill>
            ) : null}
            {item?.differences.map((field) => (
              <Badge key={field} tone="warning">
                {fieldLabels[field]}
              </Badge>
            ))}
          </>
        }
        description={item ? (item.title ?? m.products_detail_no_title()) : null}
      />
      {offline ? (
        <Alert role="status">{m.products_detail_offline()}</Alert>
      ) : null}
      {error === 'missing' ? (
        <Empty>
          <PackageX size={30} aria-hidden="true" />
          <h2>{m.products_detail_missing_title()}</h2>
          <p>{m.products_detail_missing_body()}</p>
          <Link to="/app/$organizationId/products" params={{ organizationId }}>
            {m.products_detail_browse()}
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {detail
            ? m.products_detail_refresh_failed()
            : m.products_detail_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="products-loading" role="status">
          <span className="sr-only">{m.products_detail_loading()}</span>
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
                ? m.products_explanation_differs()
                : !item.listings.length
                  ? m.products_explanation_no_catalog()
                  : item.gaps.length
                    ? m.products_explanation_some_sources()
                    : m.products_explanation_agree()}
            </h2>
            <p>
              {differenceSentence(item.differences) ??
                (item.listings.length
                  ? m.products_explanation_agree_body()
                  : m.products_explanation_no_catalog_body())}{' '}
              {m.products_explanation_method()}
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
              <h2>{m.products_stock_title()}</h2>
              <p className="products-note">{m.products_stock_note()}</p>
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
                        .map((source) =>
                          source.deleted
                            ? m.products_stock_source_removed({
                                source: source.label,
                              })
                            : m.products_stock_source({
                                source: source.label,
                                quantity: stockQuantity(source.available),
                                unit: quantityUnit(
                                  position.unit,
                                  source.available ?? '',
                                ),
                              }),
                        )
                        .join(' · ')}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.stock.length ? (
                <p className="products-note">{m.products_stock_empty()}</p>
              ) : null}
              <Link
                to="/app/$organizationId/inventory"
                params={{ organizationId }}
                search={{ skuId: item.skuId }}
              >
                {m.products_stock_open()}
              </Link>
            </Card>
            <Card className="products-section">
              <h2>{m.products_sales_title()}</h2>
              <p className="products-note">{m.products_sales_note()}</p>
              {detail.sales.sources.map((sales) => (
                <SalesBars
                  key={`${sales.connectionId}:${sales.unit}`}
                  sales={sales}
                  since={detail.sales.since}
                  label={sourceLabel(sales.connectionId)}
                />
              ))}
              {!detail.sales.sources.length ? (
                <p className="products-note">{m.products_sales_empty()}</p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>{m.products_orders_title()}</h2>
              <p className="products-note">{m.products_orders_note()}</p>
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
                      {m.products_orders_line({
                        quantity: formatSourceNumber(order.quantity),
                        unit: quantityUnit(order.unit, order.quantity),
                        status: orderStatusLabels[order.status] ?? order.status,
                      })}
                    </span>
                    <small>
                      {sourceLabel(order.connectionId)}
                      {order.placedAt ? (
                        <>
                          {' · '}
                          {rich(m.products_orders_placed, {
                            date: <WorkspaceDate value={order.placedAt} />,
                          })}
                        </>
                      ) : null}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.orders.length ? (
                <p className="products-note">{m.products_orders_empty()}</p>
              ) : null}
              {orderSearch ? (
                <Link
                  to="/app/$organizationId/orders"
                  params={{ organizationId }}
                  search={{ q: orderSearch }}
                >
                  {m.products_orders_search({ sku: orderSearch })}
                </Link>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>{m.products_supply_title()}</h2>
              <p className="products-note">{m.products_supply_note()}</p>
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
                      {m.products_orders_line({
                        quantity: formatNumber(order.quantity),
                        unit: quantityUnit(order.unit, order.quantity),
                        status:
                          purchaseOrderLabels[order.status] ?? order.status,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {!detail.purchaseOrders.length ? (
                <p className="products-note">{m.products_supply_empty()}</p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>{m.products_issues_title()}</h2>
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
                    <span>{issueStateLabel(issue.state)}</span>
                  </li>
                ))}
              </ul>
              {!detail.issues.length ? (
                <p className="products-note">{m.products_issues_empty()}</p>
              ) : null}
            </Card>
            <Card className="products-section">
              <h2>{m.products_variants_title()}</h2>
              <p className="products-note">{m.products_variants_note()}</p>
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
                <p className="products-note">{m.products_variants_empty()}</p>
              ) : null}
            </Card>
          </div>
          {detail.relatedTruncated ? (
            <Alert>{m.products_related_truncated()}</Alert>
          ) : null}
          <div id="sku-sources">{identity}</div>
          <section className="products-section">
            <h2>{m.products_history_title()}</h2>
            <p className="products-note">{m.products_history_note()}</p>
            <DataTable
              caption={m.products_history_caption()}
              rows={detail.history.entries}
              rowKey={(entry) => entry.id}
              columns={[
                {
                  key: 'time',
                  header: m.products_history_read(),
                  cell: (entry) => <WorkspaceDate value={entry.observedAt} />,
                },
                {
                  key: 'source',
                  header: m.products_history_source(),
                  cell: (entry) => (
                    <span className="products-cell">
                      <span>{sourceLabel(entry.connectionId)}</span>
                      <small>
                        {entry.deleted
                          ? m.products_history_removed()
                          : entry.current
                            ? m.products_history_current()
                            : m.products_history_earlier()}
                      </small>
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: m.products_history_status(),
                  cell: (entry) =>
                    entry.status
                      ? statusLabels[entry.status]
                      : m.common_empty_value(),
                },
                {
                  key: 'published',
                  header: m.products_history_published(),
                  hideOnNarrow: true,
                  cell: (entry) =>
                    entry.deleted
                      ? m.common_empty_value()
                      : listingLabel(
                          entry.published,
                          detail.sources.find(
                            (s) => s.connectionId === entry.connectionId,
                          )?.system ?? null,
                        ),
                },
                {
                  key: 'price',
                  header: m.products_history_price(),
                  numeric: true,
                  cell: (entry) =>
                    formatPrice(entry.price) ?? m.common_empty_value(),
                },
              ]}
            />
            {detail.history.truncated ? (
              <p className="products-note">
                {m.products_history_truncated({ count: 50 })}
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
