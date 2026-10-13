import './procurement.css';

import type { SupplierContext, SupplierRecord } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  DataTable,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { quantityWithUnit } from '@luma/ui/lib/units';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { RecordMessages } from '../../kit/record-messages';
import { PurchasingOutcomePanel } from '../../shared/procurement/purchasing-outcomes';
import { SupplierTermsSection } from '../../shared/procurement/supplier-terms';
import { stockQuantity } from '../inventory/presentation';
import {
  procurementError,
  supplierContextOptions,
  supplierRecordOptions,
} from './data';
import { OrderDialog } from './forms';
import { calendarDate, ownerLabels, quantity, StagePill } from './presentation';
import { LinkSupplierDialog } from './record-dialogs';
import { SupplierContact } from './supplier-contact';

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
      messages={
        <RecordMessages
          organizationId={organizationId}
          kind="supplier"
          recordId={supplierId}
          frame={(content) => (
            <Card
              as="section"
              className="procurement-side"
              aria-labelledby="supplier-inbox-threads"
            >
              <h2 id="supplier-inbox-threads">
                {m.messaging_record_section_title()}
              </h2>
              {content}
            </Card>
          )}
        />
      }
    />
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'attention';
}) {
  return (
    <div className="procurement-stat" data-tone={tone}>
      <strong>{formatNumber(value)}</strong>
      <span>{label}</span>
    </div>
  );
}

/** Shows what is ordered from a supplier, where each order stands and what it supplies. */
function SupplierRecordView({
  organizationId,
  record,
  context,
  loading = false,
  refreshing = false,
  error,
  reload,
  messages,
}: {
  organizationId: string;
  record?: SupplierRecord | undefined;
  context?: SupplierContext | undefined;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  reload: () => void;
  /** Inbox threads linked to the supplier, framed as an aside card. */
  messages?: ReactNode;
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
    <div className="procurement-page procurement-record">
      <RecordHeader
        section={{
          label: m.procurement_title(),
          domain: 'procurement',
          link: (
            <Link
              to="/app/$organizationId/procurement"
              params={{ organizationId }}
              search={{ view: 'suppliers', q: '', status: '' }}
            />
          ),
        }}
        title={supplier?.name ?? m.procurement_supplier_title_fallback()}
        actions={
          <>
            <RefreshButton refreshing={refreshing} onClick={reload} />
            {record?.canManage ? (
              <>
                <Button variant="outline" onClick={() => setDialog('link')}>
                  {supplier?.link
                    ? m.procurement_supplier_change_link()
                    : m.procurement_supplier_link_system()}
                </Button>
                <Button onClick={() => setDialog('order')}>
                  <Plus size={15} aria-hidden="true" />
                  {m.procurement_list_new_order()}
                </Button>
              </>
            ) : null}
          </>
        }
        status={
          <>
            {supplier ? (
              supplier.link ? (
                record?.connection?.status === 'active' ? (
                  <StatePill state="verified">
                    {m.procurement_supplier_link_active()}
                  </StatePill>
                ) : (
                  <StatePill state="attention">
                    {m.procurement_supplier_connection_unavailable()}
                  </StatePill>
                )
              ) : (
                <StatePill state="idle">{m.procurement_not_linked()}</StatePill>
              )
            ) : null}
            {record ? (
              <Badge>
                {m.procurement_supplier_confirmation_window({
                  hours: record.confirmationHours,
                })}
              </Badge>
            ) : null}
          </>
        }
        description={
          supplier
            ? supplier.link
              ? linkedDescription(
                  supplier.link.name ??
                    m.procurement_supplier_external({
                      id: supplier.link.externalId,
                    }),
                  record?.connection?.label,
                )
              : m.procurement_supplier_unlinked()
            : null
        }
      />
      {error === 'missing' ? (
        <Empty>
          <Building2 size={30} aria-hidden="true" />
          <h2>{m.procurement_supplier_missing_title()}</h2>
          <p>{m.procurement_supplier_missing_body()}</p>
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{ view: 'suppliers', q: '', status: '' }}
          >
            {m.procurement_supplier_missing_link()}
          </Link>
        </Empty>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {error}{' '}
          <Button variant="outline" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {!record && loading && !error ? (
        <div className="procurement-skeleton" role="status">
          <span className="sr-only">{m.procurement_supplier_loading()}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
      {record && supplier ? (
        <>
          <section
            className="procurement-stats"
            aria-label={m.procurement_supplier_summary()}
          >
            <Stat
              value={live.length}
              label={m.procurement_supplier_stat_open()}
            />
            <Stat
              value={waiting.length}
              label={m.procurement_supplier_stat_waiting()}
            />
            <Stat
              value={attention.length}
              label={m.procurement_supplier_stat_attention()}
              {...(attention.length ? { tone: 'attention' as const } : {})}
            />
            <Stat
              value={overdue.length}
              label={m.procurement_supplier_stat_overdue()}
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
                  <h2 id="supplier-orders">
                    {m.procurement_supplier_orders_title()}
                  </h2>
                  <span>{formatNumber(orders.length)}</span>
                </div>
                <DataTable
                  caption={m.procurement_supplier_orders_caption()}
                  density="compact"
                  rows={orders}
                  rowKey={(row) => row.order.id}
                  columns={[
                    {
                      key: 'reference',
                      header: m.procurement_column_order(),
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
                              ? record.connection?.label
                                ? m.procurement_external_order_number({
                                    system: record.connection.label,
                                    number: row.externalOrderNumber,
                                  })
                                : m.procurement_erp_order_number({
                                    number: row.externalOrderNumber,
                                  })
                              : rich(m.procurement_supplier_order_created, {
                                  date: (
                                    <WorkspaceDate
                                      value={row.order.createdAt}
                                    />
                                  ),
                                })}
                          </small>
                        </span>
                      ),
                    },
                    {
                      key: 'stage',
                      header: m.procurement_column_stage(),
                      cell: (row) => <StagePill stage={row.stage} />,
                    },
                    {
                      key: 'expected',
                      header: m.procurement_column_expected(),
                      hideOnNarrow: true,
                      cell: (row) =>
                        row.progress.expectedDate ? (
                          calendarDate(row.progress.expectedDate)
                        ) : (
                          <span className="procurement-muted">
                            {m.common_empty_value()}
                          </span>
                        ),
                    },
                    {
                      key: 'next',
                      header: m.procurement_column_next_step(),
                      hideOnNarrow: true,
                      cell: (row) => (
                        <span className="procurement-cell">
                          <span>{row.progress.next.title}</span>
                          <small>
                            {ownerLabels[row.progress.next.owner]()}
                          </small>
                        </span>
                      ),
                    },
                  ]}
                  empty={
                    <p className="procurement-empty">
                      {m.procurement_supplier_orders_empty()}
                    </p>
                  }
                />
              </section>
              <SupplierContact
                organizationId={organizationId}
                supplier={supplier}
                canManage={record.canManage}
              />
              <SupplierTermsSection
                organizationId={organizationId}
                supplierId={supplier.id}
              />
              <PurchasingOutcomePanel
                organizationId={organizationId}
                supplierId={supplier.id}
              />
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
                <h2 id="supplier-details">{m.common_details()}</h2>
                <dl className="procurement-side-facts">
                  <div>
                    <dt>{m.procurement_supplier_purchasing_system()}</dt>
                    <dd>
                      {record.connection?.label ?? (
                        <span className="procurement-muted">
                          {m.procurement_not_linked()}
                        </span>
                      )}
                      {record.connection && !record.connection.canSubmit ? (
                        <small>{m.procurement_supplier_cannot_send()}</small>
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
                    <dt>{m.procurement_column_added()}</dt>
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
                <h2 id="supplier-messages-recent">
                  {m.procurement_supplier_messages_title()}
                </h2>
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
                            {c.subject ||
                              m.procurement_supplier_message_fallback()}
                          </Link>
                        ) : (
                          <span>
                            {c.subject ||
                              m.procurement_supplier_message_fallback()}
                          </span>
                        )}
                        <small>
                          {c.from} · <WorkspaceDate value={c.receivedAt} />
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="procurement-note">
                    {m.procurement_supplier_messages_empty()}
                  </p>
                )}
              </Card>
              {messages}
              {context?.issues.length ? (
                <Card
                  as="section"
                  className="procurement-side"
                  aria-labelledby="supplier-issues"
                >
                  <h2 id="supplier-issues">{m.procurement_related_issues()}</h2>
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
    </div>
  );
}

function linkedDescription(supplier: string, system: string | undefined) {
  return system
    ? m.procurement_supplier_linked({ supplier, system })
    : m.procurement_supplier_linked_generic({ supplier });
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
        <h2 id="supplied-stock">{m.procurement_supplied_title()}</h2>
        {context?.truncated ? (
          <span>{m.procurement_supplied_truncated({ count: 50 })}</span>
        ) : null}
      </div>
      {!context ? (
        <p className="procurement-note" role="status">
          {m.procurement_supplied_loading()}
        </p>
      ) : (
        <DataTable
          caption={m.procurement_supplied_caption()}
          density="compact"
          rows={context.skus}
          rowKey={(row) => row.sku}
          columns={[
            {
              key: 'sku',
              header: m.procurement_supplied_sku(),
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
                    {row.skuId
                      ? ''
                      : ` · ${m.procurement_supplied_unknown_sku()}`}
                  </small>
                </span>
              ),
            },
            {
              key: 'stock',
              header: m.procurement_supplied_available(),
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
                          .map((s) =>
                            s.deleted
                              ? m.procurement_stock_removed()
                              : quantityWithUnit(
                                  stockQuantity(s.available),
                                  position.unit,
                                  s.available ?? '',
                                ),
                          )
                          .join(' / ')}{' '}
                        <small>{position.location}</small>
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="procurement-muted">
                    {m.procurement_stock_none()}
                  </span>
                ),
            },
            {
              key: 'onOrder',
              header: m.procurement_supplied_on_order(),
              numeric: true,
              cell: (row) =>
                row.onOrder.length ? (
                  row.onOrder
                    .map((o) =>
                      quantityWithUnit(
                        quantity(o.quantity),
                        o.unit,
                        o.quantity,
                      ),
                    )
                    .join(' · ')
                ) : (
                  <span className="procurement-muted">
                    {m.common_empty_value()}
                  </span>
                ),
            },
          ]}
          empty={
            <p className="procurement-empty">
              {m.procurement_supplied_empty()}
            </p>
          }
        />
      )}
      <p className="procurement-note">{m.procurement_supplied_note()}</p>
    </section>
  );
}
