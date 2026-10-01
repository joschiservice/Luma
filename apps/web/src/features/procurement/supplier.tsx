import './procurement.css';

import type { SupplierContext, SupplierRecord } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  DataTable,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Building2, Plus, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { stockQuantity } from '../inventory/presentation';
import {
  procurementError,
  supplierContextOptions,
  supplierRecordOptions,
} from './data';
import { OrderDialog } from './forms';
import { calendarDate, ownerLabels, quantity, StagePill } from './presentation';
import { LinkSupplierDialog } from './record-dialogs';

/** Loads a supplier record with its orders, commitments and supplied stock. */
export function SupplierPage() {
  const { organizationId, supplierId } = useParams({
    from: '/app/$organizationId/procurement/suppliers/$supplierId',
  });
  const record = useQuery(supplierRecordOptions(organizationId, supplierId));
  const context = useQuery(supplierContextOptions(organizationId, supplierId));
  if (record.error instanceof IdentityError && record.error.status === 401)
    return <SignInRedirect />;

  return (
    <SupplierRecordView
      organizationId={organizationId}
      record={record.data}
      context={context.data}
      loading={record.isPending}
      refreshing={record.isFetching}
      error={
        !record.error
          ? undefined
          : record.error instanceof IdentityError && record.error.status === 404
            ? 'missing'
            : procurementError(record.error)
      }
      reload={() => {
        void record.refetch();
        void context.refetch();
      }}
    />
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'attention';
}) {
  return (
    <div className="procurement-stat" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/** Shows what is ordered from a supplier, where each order stands and what it supplies. */
export function SupplierRecordView({
  organizationId,
  record,
  context,
  loading = false,
  refreshing = false,
  error,
  reload,
}: {
  organizationId: string;
  record?: SupplierRecord | undefined;
  context?: SupplierContext | undefined;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  reload: () => void;
}) {
  const [dialog, setDialog] = useState<'link' | 'order' | null>(null);
  const navigate = useNavigate();
  const supplier = record?.supplier;
  const orders = record?.orders ?? [];
  const live = orders.filter(
    (o) => !['closed', 'cancelled', 'received'].includes(o.stage),
  );
  const waiting = orders.filter((o) => o.stage === 'awaiting_confirmation');
  const attention = orders.filter((o) => o.progress.attention.length > 0);
  const overdue = orders.filter((o) =>
    o.progress.attention.some((a) => a.kind.endsWith('overdue')),
  );

  return (
    <main className="procurement-page procurement-record">
      <Link
        className="procurement-back"
        to="/app/$organizationId/procurement"
        params={{ organizationId }}
        search={{ view: 'suppliers', q: '', status: '' }}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Suppliers
      </Link>
      <PageHeader
        title={supplier?.name ?? 'Supplier'}
        icon={<DomainIcon domain="procurement" size="md" />}
        description={
          supplier
            ? supplier.link
              ? `Linked to ${supplier.link.name ?? `supplier ${supplier.link.externalId}`} in ${record?.connection?.label ?? 'a purchasing system'}`
              : 'Not linked to a purchasing system. Orders are tracked in Luma only.'
            : 'Orders, commitments and stock for one supplier.'
        }
        actions={
          record?.canManage ? (
            <>
              <Button variant="outline" onClick={() => setDialog('link')}>
                {supplier?.link ? 'Change link' : 'Link to purchasing system'}
              </Button>
              <Button onClick={() => setDialog('order')}>
                <Plus size={15} aria-hidden="true" />
                New purchase order
              </Button>
            </>
          ) : null
        }
      />
      <div className="procurement-record-toolbar">
        <span className="procurement-flags">
          {supplier ? (
            supplier.link ? (
              record?.connection?.status === 'active' ? (
                <StatePill state="verified">Purchasing link active</StatePill>
              ) : (
                <StatePill state="attention">
                  Purchasing connection unavailable
                </StatePill>
              )
            ) : (
              <StatePill state="idle">Not linked</StatePill>
            )
          ) : null}
          {record ? (
            <Badge>Confirms within {record.confirmationHours} h</Badge>
          ) : null}
        </span>
        <Button variant="ghost" disabled={refreshing} onClick={reload}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {error === 'missing' ? (
        <Empty>
          <Building2 size={30} aria-hidden="true" />
          <h2>Supplier not found</h2>
          <p>This supplier is not in this workspace.</p>
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{ view: 'suppliers', q: '', status: '' }}
          >
            Browse suppliers
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          <Button variant="outline" onClick={reload}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!record && loading && !error ? (
        <div className="procurement-skeleton" role="status">
          <span className="sr-only">Loading supplier…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {record && supplier ? (
        <>
          <section className="procurement-stats" aria-label="Supplier summary">
            <Stat value={live.length} label="Open commitments" />
            <Stat value={waiting.length} label="Awaiting confirmation" />
            <Stat
              value={attention.length}
              label="Need a response"
              {...(attention.length ? { tone: 'attention' as const } : {})}
            />
            <Stat
              value={overdue.length}
              label="Overdue"
              {...(overdue.length ? { tone: 'attention' as const } : {})}
            />
          </section>
          <div className="procurement-record-layout">
            <div className="procurement-record-main">
              <section
                className="procurement-section"
                aria-labelledby="supplier-orders"
              >
                <div className="procurement-section-heading">
                  <h2 id="supplier-orders">Purchase orders</h2>
                  <span>{orders.length}</span>
                </div>
                <DataTable
                  caption="Purchase orders for this supplier"
                  density="compact"
                  rows={orders}
                  rowKey={(row) => row.order.id}
                  columns={[
                    {
                      key: 'reference',
                      header: 'Order',
                      cell: (row) => (
                        <span className="procurement-cell">
                          <DataTableRowLink
                            render={
                              <Link
                                to="/app/$organizationId/procurement/$purchaseOrderId"
                                params={{
                                  organizationId,
                                  purchaseOrderId: row.order.id,
                                }}
                              />
                            }
                          >
                            {row.order.reference}
                          </DataTableRowLink>
                          <small>
                            {row.externalOrderNumber
                              ? `${record.connection?.label ?? 'Purchasing'} ${row.externalOrderNumber}`
                              : `Created `}
                            {row.externalOrderNumber ? null : (
                              <WorkspaceDate value={row.order.createdAt} />
                            )}
                          </small>
                        </span>
                      ),
                    },
                    {
                      key: 'stage',
                      header: 'Stage',
                      cell: (row) => <StagePill stage={row.stage} />,
                    },
                    {
                      key: 'expected',
                      header: 'Expected',
                      hideOnNarrow: true,
                      cell: (row) =>
                        row.progress.expectedDate ? (
                          calendarDate(row.progress.expectedDate)
                        ) : (
                          <span className="procurement-muted">—</span>
                        ),
                    },
                    {
                      key: 'next',
                      header: 'Next',
                      hideOnNarrow: true,
                      cell: (row) => (
                        <span className="procurement-cell">
                          <span>{row.progress.next.title}</span>
                          <small>{ownerLabels[row.progress.next.owner]}</small>
                        </span>
                      ),
                    },
                  ]}
                  empty={
                    <p className="procurement-empty">
                      No purchase orders with this supplier yet.
                    </p>
                  }
                />
              </section>
              <SuppliedStock
                organizationId={organizationId}
                context={context}
              />
            </div>
            <aside className="procurement-record-aside">
              <Card
                as="section"
                className="procurement-side"
                aria-labelledby="supplier-details"
              >
                <h2 id="supplier-details">Details</h2>
                <dl className="procurement-side-facts">
                  <div>
                    <dt>Purchasing system</dt>
                    <dd>
                      {record.connection?.label ?? (
                        <span className="procurement-muted">Not linked</span>
                      )}
                      {record.connection && !record.connection.canSubmit ? (
                        <small>
                          Can’t place orders. Reconnect with purchase-order
                          access.
                        </small>
                      ) : null}
                    </dd>
                  </div>
                  {supplier.externalReferences.map((ref) => (
                    <div key={`${ref.system}:${ref.externalId}`}>
                      <dt>{ref.system}</dt>
                      <dd>
                        <code>{ref.externalId}</code>
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Added</dt>
                    <dd>
                      <WorkspaceDate value={supplier.createdAt} />
                    </dd>
                  </div>
                </dl>
              </Card>
              <Card
                as="section"
                className="procurement-side"
                aria-labelledby="supplier-messages-recent"
              >
                <h2 id="supplier-messages-recent">Recent messages</h2>
                {record.communications.length ? (
                  <ul className="procurement-side-list">
                    {record.communications.slice(0, 6).map((c) => (
                      <li key={c.id}>
                        {c.purchaseOrderId ? (
                          <Link
                            to="/app/$organizationId/procurement/$purchaseOrderId"
                            params={{
                              organizationId,
                              purchaseOrderId: c.purchaseOrderId,
                            }}
                            hash="supplier-messages"
                          >
                            {c.subject || 'Supplier message'}
                          </Link>
                        ) : (
                          <span>{c.subject || 'Supplier message'}</span>
                        )}
                        <small>
                          {c.from} · <WorkspaceDate value={c.receivedAt} />
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="procurement-note">No messages recorded.</p>
                )}
              </Card>
              {context?.issues.length ? (
                <Card
                  as="section"
                  className="procurement-side"
                  aria-labelledby="supplier-issues"
                >
                  <h2 id="supplier-issues">Related issues</h2>
                  <ul className="procurement-side-list">
                    {context.issues.map((issue) => (
                      <li key={issue.id}>
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{ organizationId, exceptionId: issue.id }}
                          search={{ view: 'needs_you' }}
                        >
                          {issue.label}
                        </Link>
                        <small>{issue.state.replaceAll('_', ' ')}</small>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
      {record && supplier && dialog === 'link' ? (
        <LinkSupplierDialog
          organizationId={organizationId}
          supplier={{
            ...supplier,
            confirmationHours: record.confirmationHours,
          }}
          close={() => setDialog(null)}
        />
      ) : null}
      {supplier && dialog === 'order' ? (
        <OrderDialog
          organizationId={organizationId}
          suppliers={[supplier]}
          close={() => setDialog(null)}
          saved={(order) => {
            setDialog(null);
            void navigate({
              to: '/app/$organizationId/procurement/$purchaseOrderId',
              params: { organizationId, purchaseOrderId: order.id },
            });
          }}
        />
      ) : null}
    </main>
  );
}

/** SKUs ordered from this supplier with current stock and units still on order. */
function SuppliedStock({
  organizationId,
  context,
}: {
  organizationId: string;
  context?: SupplierContext | undefined;
}) {
  return (
    <section className="procurement-section" aria-labelledby="supplied-stock">
      <div className="procurement-section-heading">
        <h2 id="supplied-stock">Supplied items and stock</h2>
        {context?.truncated ? (
          <span>Showing the 50 most recent SKUs</span>
        ) : null}
      </div>
      {!context ? (
        <p className="procurement-note" role="status">
          Loading stock…
        </p>
      ) : (
        <DataTable
          caption="SKUs ordered from this supplier"
          density="compact"
          rows={context.skus}
          rowKey={(row) => row.sku}
          columns={[
            {
              key: 'sku',
              header: 'SKU',
              cell: (row) => (
                <span className="procurement-cell">
                  {row.skuId ? (
                    <Link
                      to="/app/$organizationId/products/$skuId"
                      params={{ organizationId, skuId: row.skuId }}
                    >
                      {row.title ?? row.positions[0]?.sku ?? row.sku}
                    </Link>
                  ) : (
                    <span>{row.sku}</span>
                  )}
                  <small>
                    <code>{row.positions[0]?.sku ?? row.sku}</code>
                    {row.skuId ? '' : ' · not a known SKU'}
                  </small>
                </span>
              ),
            },
            {
              key: 'stock',
              header: 'Available now',
              cell: (row) =>
                row.positions.length ? (
                  <span className="procurement-cell">
                    {row.positions.slice(0, 3).map((position) => (
                      <Link
                        key={position.id}
                        to="/app/$organizationId/inventory/$positionId"
                        params={{ organizationId, positionId: position.id }}
                      >
                        {position.sources
                          .map(
                            (s) =>
                              `${s.deleted ? 'removed' : stockQuantity(s.available)} ${position.unit}`,
                          )
                          .join(' / ')}{' '}
                        <small>{position.location}</small>
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="procurement-muted">No stock observed</span>
                ),
            },
            {
              key: 'onOrder',
              header: 'On order here',
              numeric: true,
              cell: (row) =>
                row.onOrder.length ? (
                  row.onOrder
                    .map((o) => `${quantity(o.quantity)} ${o.unit}`)
                    .join(' · ')
                ) : (
                  <span className="procurement-muted">—</span>
                ),
            },
          ]}
          empty={
            <p className="procurement-empty">
              Items appear here once they are on an order with this supplier.
            </p>
          }
        />
      )}
      <p className="procurement-note">
        Units on order are draft or open purchase orders, not confirmed incoming
        stock.
      </p>
    </section>
  );
}
