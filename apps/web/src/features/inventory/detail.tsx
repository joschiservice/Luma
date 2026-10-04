import './inventory.css';

import type { InventoryDetail, StockSource } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { IdentityLinks } from '../sync/identity-links';
import { WorkflowCoverageCard } from '../workflows/coverage';
import { type InventorySearch, stockOptions } from './data';
import { stockFreshness, stockQuantity, StockState } from './presentation';

/** Loads a stock investigation while keeping the list's search and return context. */
export function StockPage() {
  const { organizationId, positionId } = useParams({
    from: '/app/$organizationId/inventory/$positionId',
  });
  const search = useSearch({
    from: '/app/$organizationId/inventory/$positionId',
  });
  const apps = useQuery(appsOptions(organizationId));
  const query = useQuery(stockOptions(organizationId, positionId));
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <StockDetailView
      organizationId={organizationId}
      search={search}
      detail={query.isError ? undefined : query.data}
      error={query.error?.message}
      loading={query.isPending}
      refreshing={query.isFetching}
      offline={query.isPaused}
      refresh={() => void query.refetch()}
      correction={
        query.data &&
        apps.data?.installations.some(
          (app) => app.appId === 'shopify' && app.status === 'installed',
        ) ? (
          <AppExtension
            appId="shopify"
            organizationId={organizationId}
            slot="inventory"
            inventory={{ positionId }}
            done={async () => {
              await query.refetch();
            }}
          />
        ) : null
      }
      replenishment={
        query.data ? (
          <WorkflowCoverageCard
            organizationId={organizationId}
            positionId={positionId}
            className="inventory-section"
          />
        ) : null
      }
      identity={
        query.data ? (
          <IdentityLinks
            organizationId={organizationId}
            entityId={query.data.position.skuId}
            onChanged={() => void query.refetch()}
          />
        ) : null
      }
    />
  );
}

/** Shows a source comparison followed by the evidence and work needed to investigate a mismatch. */
export function StockDetailView({
  organizationId,
  search = {},
  detail,
  error,
  loading = false,
  refreshing = false,
  offline = false,
  refresh,
  identity,
  correction,
  replenishment,
}: {
  organizationId: string;
  search?: InventorySearch;
  detail?: InventoryDetail | undefined;
  error?: string | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  refresh: () => void;
  /** The sources behind this SKU and link controls. */
  identity?: ReactNode;
  /** Installed provider correction controls for this stock position. */
  correction?: ReactNode;
  /** Workflow coverage and readiness for this stock position. */
  replenishment?: ReactNode;
}) {
  const position = detail?.position;
  const { from: returnTo, ...listSearch } = search;
  const back = recordReturnPath(organizationId, returnTo);

  return (
    <main className="inventory-page">
      {back ? (
        <Link className="inventory-back" to={back}>
          <ArrowLeft size={14} />
          Back to context
        </Link>
      ) : (
        <Link
          className="inventory-back"
          to="/app/$organizationId/inventory"
          params={{ organizationId }}
          search={listSearch}
        >
          <ArrowLeft size={14} />
          Back to inventory
        </Link>
      )}
      <PageHeader
        title={position?.sku ?? 'Stock position'}
        icon={<DomainIcon domain="inventory" size="md" />}
        description={
          position
            ? `${position.location} · ${position.unit}`
            : 'Compare source quantities and related work.'
        }
      />
      <div className="inventory-detail-toolbar">
        {position ? <StockState position={position} /> : null}
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          <RefreshCw size={14} />
          Refresh stock
        </Button>
      </div>
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
        </Alert>
      ) : null}
      {loading && !error ? <p role="status">Loading stock position…</p> : null}
      {detail && position ? (
        <>
          <section
            className="inventory-explanation"
            aria-labelledby="stock-explanation"
          >
            <h2 id="stock-explanation">
              {position.differences.length
                ? 'Same position. Different source quantities.'
                : 'The source facts behind this position'}
            </h2>
            <p>
              {position.differences.length
                ? `Sources disagree on ${position.differences.map((field) => ({ onHand: 'on-hand', reserved: 'reserved', available: 'available' })[field]).join(', ')} stock. Compare observation times and availability methods before deciding which quantity to trust.`
                : 'Only known quantities are compared. Agreement does not confirm a fresh read or establish which source is authoritative.'}
            </p>
            <p>
              Quantities are shown per source and are never added together.
              Refresh reloads Luma’s latest observations.
            </p>
          </section>
          <DataTable
            className="inventory-comparison"
            caption="Source quantity comparison"
            rows={position.sources}
            rowKey={(source) => source.connectionId}
            columns={[
              {
                key: 'source',
                header: 'Source / provenance',
                cell: (source: StockSource) => (
                  <div className="inventory-cell">
                    <strong>{source.label}</strong>
                    <small>
                      {source.status} ·{' '}
                      {source.mappingMethod ?? 'Mapping method unknown'}
                    </small>
                    <small>
                      SKU {source.externalSku ?? 'Unknown'} · Location{' '}
                      {source.externalLocation ?? 'Unknown'}
                    </small>
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
                  cell: (source: StockSource) => (
                    <span
                      className={
                        position.differences.some((value) => value === field)
                          ? 'inventory-difference'
                          : ''
                      }
                    >
                      {source.deleted ? '—' : stockQuantity(source[field])}
                    </span>
                  ),
                }),
              ),
              {
                key: 'basis',
                header: 'Availability method',
                cell: (source: StockSource) =>
                  source.availabilityBasis === 'derived'
                    ? 'On hand − reserved'
                    : source.availabilityBasis === 'provider_reported'
                      ? 'Reported by source'
                      : 'Unknown',
              },
              {
                key: 'observed',
                header: 'Freshness',
                cell: (source: StockSource) => (
                  <div className="inventory-cell">
                    <span>{stockFreshness(source, detail.asOf)}</span>
                    <small>
                      Observed <WorkspaceDate value={source.observedAt} />
                    </small>
                    <small>
                      Source updated{' '}
                      {source.sourceUpdatedAt ? (
                        <WorkspaceDate value={source.sourceUpdatedAt} />
                      ) : (
                        'Unknown'
                      )}
                    </small>
                  </div>
                ),
              },
            ]}
          />
          {correction}
          {replenishment}
          <div className="inventory-context-grid">
            <Card className="inventory-section">
              <h2>Orders with this SKU</h2>
              <p className="inventory-note">
                Source order quantities. Location allocation and remaining
                demand are not confirmed.
              </p>
              <ul className="inventory-related">
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
                      {position.sources.find(
                        (s) => s.connectionId === order.connectionId,
                      )?.label ?? 'Connected source'}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.orders.length ? (
                <p className="inventory-note">
                  No observed orders linked to this SKU.
                </p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>Supply commitments</h2>
              <p className="inventory-note">
                Purchase order quantities are not confirmed incoming stock.
                Receipt progress and destination are unknown.
              </p>
              <ul className="inventory-related">
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
                <p className="inventory-note">
                  No purchase orders linked to this SKU.
                </p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>Stock issues</h2>
              <ul className="inventory-related">
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
                <p className="inventory-note">
                  No recorded issues for this SKU or position.
                </p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>SKU & locations</h2>
              <div className="inventory-record-links">
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: position.skuId }}
                >
                  Product listings for this SKU
                </Link>
                <Link
                  to="/app/$organizationId/records/$kind/$recordId"
                  params={{
                    organizationId,
                    kind: 'sku',
                    recordId: position.skuId,
                  }}
                >
                  Open SKU record
                </Link>
                <Link
                  to="/app/$organizationId/inventory"
                  params={{ organizationId }}
                  search={{ skuId: position.skuId }}
                >
                  All locations for this SKU
                </Link>
                <Link
                  to="/app/$organizationId/inventory"
                  params={{ organizationId }}
                  search={{ locationId: position.locationId }}
                >
                  Other SKUs at this location
                </Link>
              </div>
            </Card>
          </div>
          {identity}
          {detail.relatedTruncated ? (
            <Alert>
              Showing the first 50 entries per related record type. Open Orders
              or Procurement to continue investigating.
            </Alert>
          ) : null}
          <section className="inventory-section">
            <h2>Recent observations</h2>
            <p className="inventory-note">
              Recorded source snapshots, newest first. An observation is
              evidence of a read, not necessarily a stock movement. “Current”
              marks the snapshot selected for that source.
            </p>
            <DataTable
              caption="Stock observation history"
              rows={detail.history.entries}
              rowKey={(entry) => entry.id}
              columns={[
                {
                  key: 'time',
                  header: 'Observed',
                  cell: (entry) => <WorkspaceDate value={entry.observedAt} />,
                },
                {
                  key: 'source',
                  header: 'Source',
                  cell: (entry) => (
                    <div className="inventory-cell">
                      <span>{entry.label}</span>
                      <small>
                        {entry.deleted
                          ? 'Removed at source'
                          : entry.current
                            ? 'Current'
                            : 'Earlier observation'}
                      </small>
                    </div>
                  ),
                },
                ...(['onHand', 'reserved', 'available'] as const).map(
                  (field) => ({
                    key: field,
                    header: {
                      onHand: 'On hand',
                      reserved: 'Reserved',
                      available: 'Available',
                    }[field],
                    numeric: true,
                    cell: (entry: StockSource) => stockQuantity(entry[field]),
                  }),
                ),
              ]}
            />
            {detail.history.truncated ? (
              <p className="inventory-note">
                Showing the 100 most recent observations.
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
