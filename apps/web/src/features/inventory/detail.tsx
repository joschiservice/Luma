import './inventory.css';

import type { InventoryDetail, StockSource } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { quantityUnit, unitOfMeasure } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useContext } from 'react';

import { appsOptions } from '../../kit/apps/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { RecordAssistance } from '../../kit/record-assistance';
import {
  connectionStatusLabel,
  formatSourceNumber,
  issueStateLabel,
  purchaseOrderLabels,
  statusLabels as orderStatusLabels,
} from '../../shared/orders/presentation';
import { IncomingStockSection } from '../../shared/procurement/incoming-stock';
import { StockProtectionNotice } from '../../shared/stock-protection/notice';
import { AppExtension } from '../apps/extension';
import { recordReturnPath } from '../records/data';
import { IdentityLinks } from '../sync/identity-links';
import { linkMethodLabel } from '../sync/presentation';
import { WorkflowCoverageCard } from '../workflows/coverage';
import { type InventorySearch, stockOptions } from './data';
import { NativeStockPool } from './native-stock';
import {
  differingQuantities,
  quantityLabels,
  stockFreshness,
  stockQuantity,
  StockState,
  StockWriteAttribution,
  syncExplanation,
} from './presentation';

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
  if (query.error instanceof ApiError && query.error.status === 401)
    return <SignInRedirect />;

  return (
    <StockDetailView
      contextualAssistance
      organizationId={organizationId}
      search={search}
      detail={query.isError ? undefined : query.data}
      error={query.error?.message}
      loading={query.isPending}
      refreshing={query.isFetching}
      offline={query.isPaused}
      refresh={() => void query.refetch()}
      stockProtection={
        query.data ? (
          <StockProtectionNotice
            organizationId={organizationId}
            positionId={positionId}
          />
        ) : null
      }
      incoming={
        query.data ? (
          <IncomingStockSection
            organizationId={organizationId}
            skuId={query.data.position.skuId}
            locationId={query.data.position.locationId}
          />
        ) : null
      }
      nativeStock={
        query.data ? (
          <NativeStockPool
            organizationId={organizationId}
            detail={query.data}
          />
        ) : null
      }
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
  contextualAssistance = false,
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
  nativeStock,
  incoming,
  replenishment,
  stockProtection,
}: {
  organizationId: string;
  /** Incident protection loaded by the connected page. */
  stockProtection?: ReactNode;
  /** The connected page supplies the authorized assistant control. */
  contextualAssistance?: boolean;
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
  nativeStock?: ReactNode;
  incoming?: ReactNode;
  /** Workflow coverage and readiness for this stock position. */
  replenishment?: ReactNode;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const position = detail?.position;
  const { from: returnTo, ...listSearch } = search;
  const back = recordReturnPath(organizationId, returnTo);

  return (
    <div className="inventory-page">
      {stockProtection}
      <RecordHeader
        section={{
          label: m.inventory_page_title(),
          domain: 'inventory',
          link: (
            <Link
              to="/app/$organizationId/inventory"
              params={{ organizationId }}
              search={listSearch}
            />
          ),
        }}
        title={position?.sku ?? m.inventory_detail_title_fallback()}
        back={back ? <Link to={back} /> : undefined}
        actions={
          <>
            {position ? (
              contextualAssistance ? (
                <RecordAssistance
                  organizationId={organizationId}
                  context={{
                    record: { kind: 'stock_position', id: position.id },
                  }}
                  label={position.sku}
                />
              ) : null
            ) : null}
            {position ? (
              <Button
                variant="ghost"
                render={
                  <Link
                    to="/app/$organizationId/inventory/transfers"
                    params={{ organizationId }}
                    search={{
                      skuId: position.skuId,
                      locationId: position.locationId,
                    }}
                  />
                }
                nativeButton={false}
              >
                {m.inventory_transfer_nav()}
              </Button>
            ) : null}
            <RefreshButton
              refreshing={refreshing}
              onClick={refresh}
              label={m.inventory_detail_refresh()}
            />
          </>
        }
        status={position ? <StockState position={position} /> : null}
        description={
          position
            ? `${position.location} · ${unitOfMeasure(position.unit)}`
            : null
        }
      />
      {offline ? <Alert role="status">{m.inventory_offline()}</Alert> : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {m.inventory_detail_load_failed()} {error}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {loading && !error ? (
        <p role="status">{m.inventory_detail_loading()}</p>
      ) : null}
      {detail && position ? (
        <>
          <section
            className="inventory-explanation"
            aria-labelledby="stock-explanation"
          >
            <h2 id="stock-explanation">
              {!position.differences.length
                ? m.inventory_explanation_agree()
                : position.sync
                  ? m.inventory_explanation_syncing()
                  : m.inventory_explanation_differs()}
            </h2>
            <p>
              {!position.differences.length
                ? m.inventory_explanation_agree_body()
                : position.sync
                  ? syncExplanation(
                      position.sync,
                      position.differences,
                      timeZone,
                    )
                  : m.inventory_explanation_differs_body({
                      fields: differingQuantities(position.differences),
                    })}
            </p>
            <p>{m.inventory_explanation_separate()}</p>
          </section>
          {correction}
          <DataTable
            className="inventory-comparison"
            caption={m.inventory_comparison_caption()}
            rows={position.sources}
            rowKey={(source) => source.connectionId}
            columns={[
              {
                key: 'source',
                header: m.inventory_comparison_source(),
                cell: (source: StockSource) => (
                  <div className="inventory-cell">
                    <strong>{source.label}</strong>
                    {source.bundleContext ? (
                      <small>
                        {m.products_bundles_parent()} ·{' '}
                        <WorkspaceDate
                          value={source.bundleContext.observedAt}
                        />
                      </small>
                    ) : null}
                    <StockWriteAttribution source={source} />
                    <small>
                      {connectionStatusLabel(source.status)} ·{' '}
                      {source.mappingMethod
                        ? linkMethodLabel(source.mappingMethod)
                        : m.inventory_link_method_unrecorded()}
                    </small>
                    <small>
                      {source.externalSku
                        ? m.inventory_source_sku({ sku: source.externalSku })
                        : m.inventory_source_sku_missing()}
                      {' · '}
                      {source.externalLocation
                        ? m.inventory_source_location({
                            location: source.externalLocation,
                          })
                        : m.inventory_source_location_missing()}
                    </small>
                  </div>
                ),
              },
              ...(
                [
                  'available',
                  'onHand',
                  'committed',
                  'reserved',
                  'incoming',
                ] as const
              ).map((field) => ({
                key: field,
                header: quantityLabels[field](),
                numeric: true,
                cell: (source: StockSource) => (
                  <span
                    className={
                      position.differences.some((value) => value === field)
                        ? 'inventory-difference'
                        : ''
                    }
                  >
                    {source.deleted
                      ? m.common_empty_value()
                      : stockQuantity(source[field])}
                  </span>
                ),
              })),
              {
                key: 'basis',
                header: m.inventory_comparison_basis(),
                cell: (source: StockSource) =>
                  source.availabilityBasis === 'derived'
                    ? m.inventory_basis_derived_formula()
                    : source.availabilityBasis === 'provider_reported'
                      ? m.inventory_basis_reported_by_source()
                      : m.common_not_reported(),
              },
              {
                key: 'observed',
                header: m.inventory_comparison_freshness(),
                cell: (source: StockSource) => (
                  <div className="inventory-cell">
                    <span>{stockFreshness(source, detail.asOf)}</span>
                    <small>
                      {rich(m.inventory_comparison_read, {
                        date: <WorkspaceDate value={source.observedAt} />,
                      })}
                    </small>
                    <small>
                      {source.sourceUpdatedAt
                        ? rich(m.inventory_comparison_source_updated, {
                            date: (
                              <WorkspaceDate value={source.sourceUpdatedAt} />
                            ),
                          })
                        : m.inventory_comparison_source_updated_missing()}
                    </small>
                  </div>
                ),
              },
            ]}
          />
          <Disclosure>
            <summary>{m.inventory_provider_states_title()}</summary>
            <p className="inventory-note">
              {m.inventory_provider_states_note()}
            </p>
            <DataTable
              caption={m.inventory_provider_states_title()}
              rows={position.sources}
              rowKey={(source) => source.connectionId}
              columns={[
                {
                  key: 'source',
                  header: m.inventory_comparison_source(),
                  cell: (source: StockSource) => source.label,
                },
                ...(['damaged', 'qualityControl', 'safetyStock'] as const).map(
                  (field) => ({
                    key: field,
                    header: quantityLabels[field](),
                    numeric: true,
                    cell: (source: StockSource) =>
                      source.deleted
                        ? m.common_empty_value()
                        : stockQuantity(source[field]),
                  }),
                ),
                ...(['locationActive', 'itemActive', 'tracked'] as const).map(
                  (field) => ({
                    key: field,
                    header:
                      field === 'locationActive'
                        ? m.inventory_location_active()
                        : field === 'itemActive'
                          ? m.inventory_item_active()
                          : m.inventory_item_tracked(),
                    cell: (source: StockSource) =>
                      source.deleted || source[field] == null
                        ? m.common_not_reported()
                        : source[field]
                          ? m.inventory_activation_yes()
                          : m.inventory_activation_no(),
                  }),
                ),
              ]}
            />
          </Disclosure>
          {incoming}
          {nativeStock}
          {replenishment}
          <div className="inventory-context-grid">
            <Card className="inventory-section">
              <h2>{m.inventory_orders_title()}</h2>
              <p className="inventory-note">{m.inventory_orders_note()}</p>
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
                      {m.inventory_orders_line({
                        quantity: formatSourceNumber(order.quantity),
                        unit: quantityUnit(order.unit, order.quantity),
                        status: orderStatusLabels[order.status] ?? order.status,
                      })}
                    </span>
                    <small>
                      {position.sources.find(
                        (s) => s.connectionId === order.connectionId,
                      )?.label ?? m.inventory_source_fallback()}
                    </small>
                  </li>
                ))}
              </ul>
              {!detail.orders.length ? (
                <p className="inventory-note">{m.inventory_orders_empty()}</p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>{m.inventory_supply_title()}</h2>
              <p className="inventory-note">{m.inventory_supply_note()}</p>
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
                      {m.inventory_orders_line({
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
                <p className="inventory-note">{m.inventory_supply_empty()}</p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>{m.inventory_issues_title()}</h2>
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
                    <span>{issueStateLabel(issue.state)}</span>
                  </li>
                ))}
              </ul>
              {!detail.issues.length ? (
                <p className="inventory-note">{m.inventory_issues_empty()}</p>
              ) : null}
            </Card>
            <Card className="inventory-section">
              <h2>{m.inventory_links_title()}</h2>
              <div className="inventory-record-links">
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: position.skuId }}
                >
                  {m.inventory_links_product()}
                </Link>
                <Link
                  to="/app/$organizationId/records/$kind/$recordId"
                  params={{
                    organizationId,
                    kind: 'sku',
                    recordId: position.skuId,
                  }}
                >
                  {m.inventory_links_record()}
                </Link>
                <Link
                  to="/app/$organizationId/inventory"
                  params={{ organizationId }}
                  search={{ skuId: position.skuId }}
                >
                  {m.inventory_links_locations()}
                </Link>
                <Link
                  to="/app/$organizationId/inventory"
                  params={{ organizationId }}
                  search={{ locationId: position.locationId }}
                >
                  {m.inventory_links_location_skus()}
                </Link>
              </div>
            </Card>
          </div>
          {identity}
          {detail.relatedTruncated ? (
            <Alert>{m.inventory_related_truncated()}</Alert>
          ) : null}
          <section className="inventory-section">
            <h2>{m.inventory_history_title()}</h2>
            <p className="inventory-note">{m.inventory_history_note()}</p>
            <DataTable
              caption={m.inventory_history_caption()}
              rows={detail.history.entries}
              rowKey={(entry) => entry.id}
              columns={[
                {
                  key: 'time',
                  header: m.inventory_history_read(),
                  cell: (entry) => <WorkspaceDate value={entry.observedAt} />,
                },
                {
                  key: 'source',
                  header: m.inventory_history_source(),
                  cell: (entry) => (
                    <div className="inventory-cell">
                      <span>{entry.label}</span>
                      <StockWriteAttribution source={entry} />
                      <small>
                        {entry.deleted
                          ? m.inventory_history_removed()
                          : entry.current
                            ? m.inventory_history_current()
                            : m.inventory_history_earlier()}
                      </small>
                    </div>
                  ),
                },
                ...(
                  [
                    'onHand',
                    'committed',
                    'reserved',
                    'available',
                    'incoming',
                    'damaged',
                    'qualityControl',
                    'safetyStock',
                  ] as const
                ).map((field) => ({
                  key: field,
                  header: quantityLabels[field](),
                  numeric: true,
                  cell: (entry: StockSource) => stockQuantity(entry[field]),
                })),
              ]}
            />
            {detail.history.truncated ? (
              <p className="inventory-note">
                {m.inventory_history_truncated({ count: 100 })}
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
