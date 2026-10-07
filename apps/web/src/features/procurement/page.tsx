import './procurement.css';

import {
  type OrderStage,
  orderStageSchema,
  type OrderSummary,
  type PurchaseOrder,
  type Supplier,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
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
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowUpRight,
  Building2,
  CircleDot,
  FileText,
  PackageCheck,
  Plus,
} from 'lucide-react';
import { useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  ordersOptions,
  procurementError,
  progressOptions,
  suppliersOptions,
} from './data';
import { OrderDialog, SupplierDialog } from './forms';
import {
  calendarDate,
  OrderStatus,
  ownerLabels,
  StagePill,
  stages,
  statusLabels,
} from './presentation';
import { ReplenishmentOverview } from './replenishment-overview';

function orderColumns(
  organizationId: string,
  progress: Map<string, OrderSummary> | undefined,
): DataTableColumn<PurchaseOrder>[] {
  return [
    {
      key: 'reference',
      header: 'Purchase order',
      cell: (order) => (
        <span className="procurement-cell">
          <DataTableRowLink
            render={
              <Link
                to="/app/$organizationId/procurement/$purchaseOrderId"
                params={{ organizationId, purchaseOrderId: order.id }}
              />
            }
          >
            {order.reference}
          </DataTableRowLink>
          <small>
            {order.lines.length} {order.lines.length === 1 ? 'line' : 'lines'}
            {progress?.get(order.id)?.externalOrderNumber
              ? ` · ERP ${progress.get(order.id)!.externalOrderNumber}`
              : ''}
          </small>
        </span>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      cell: (order) => order.supplierName,
    },
    {
      key: 'stage',
      header: 'Stage',
      cell: (order) => {
        const summary = progress?.get(order.id);

        return summary ? (
          <span className="procurement-flags">
            <StagePill stage={summary.stage} />
            {summary.attention ? (
              <Badge tone={summary.overdue ? 'danger' : 'warning'}>
                {summary.overdue ? 'Overdue' : `${summary.attention} to answer`}
              </Badge>
            ) : null}
          </span>
        ) : (
          <OrderStatus status={order.status} />
        );
      },
    },
    {
      key: 'expected',
      header: 'Expected',
      hideOnNarrow: true,
      cell: (order) => {
        const date = progress?.get(order.id)?.expectedDate;

        return date ? (
          calendarDate(date)
        ) : (
          <span className="procurement-muted">—</span>
        );
      },
    },
    {
      key: 'next',
      header: 'Who’s next',
      hideOnNarrow: true,
      cell: (order) => {
        const owner = progress?.get(order.id)?.nextOwner;

        return owner ? ownerLabels[owner] : '—';
      },
    },
  ];
}

function supplierColumns({
  organizationId,
  orderCount,
  showOrders,
}: {
  organizationId: string;
  orderCount: (supplier: Supplier) => number | undefined;
  showOrders: (supplier: Supplier) => void;
}): DataTableColumn<Supplier>[] {
  return [
    {
      key: 'name',
      header: 'Supplier',
      cell: (supplier) => (
        <DataTableRowLink
          render={
            <Link
              to="/app/$organizationId/procurement/suppliers/$supplierId"
              params={{ organizationId, supplierId: supplier.id }}
            />
          }
        >
          {supplier.name}
        </DataTableRowLink>
      ),
    },
    {
      key: 'link',
      header: 'Purchasing link',
      hideOnNarrow: true,
      cell: (supplier) =>
        supplier.link ? (
          <StatePill state="verified">
            {supplier.link.name ?? `Supplier ${supplier.link.externalId}`}
          </StatePill>
        ) : (
          <span className="procurement-muted">Not linked</span>
        ),
    },
    {
      key: 'references',
      header: 'External references',
      hideOnNarrow: true,
      cell: (supplier) =>
        supplier.externalReferences.length
          ? supplier.externalReferences
              .map((ref) => `${ref.system} · ${ref.externalId}`)
              .join(' / ')
          : 'None',
    },
    {
      key: 'added',
      header: 'Added',
      hideOnNarrow: true,
      cell: (supplier) => <WorkspaceDate value={supplier.createdAt} />,
    },
    {
      key: 'orders',
      header: 'Orders',
      numeric: true,
      cell: (supplier) => orderCount(supplier) ?? '—',
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (supplier) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`View orders for ${supplier.name}`}
          title="View orders"
          onClick={() => showOrders(supplier)}
        >
          <ArrowUpRight size={16} aria-hidden="true" />
        </Button>
      ),
    },
  ];
}

const stageFilters = ['attention', ...orderStageSchema.options] as const;

/**
 * Lists the order stage filter choices. A legacy `status` link has no stage, so its status is
 * offered as one more choice while it applies, letting the chip name it.
 */
function stageOptions(status: string) {
  const legacy = Object.entries(statusLabels).find(
    ([value]) => value === status,
  );

  return [
    { value: 'attention', label: 'Needs a response' },
    ...orderStageSchema.options.map((value) => ({
      value,
      label: stages[value].label,
    })),
    ...(legacy ? [{ value: `status:${legacy[0]}`, label: legacy[1] }] : []),
  ];
}

/** Keeps procurement views and filters shareable without accepting unsupported statuses. */
export function parseProcurementSearch(value: Record<string, unknown>): {
  view: 'orders' | 'suppliers';
  q: string;
  status: string;
  stage?: OrderStage | 'attention';
} {
  const stage =
    typeof value.stage === 'string' &&
    (value.stage === 'attention' || Object.hasOwn(stages, value.stage))
      ? (value.stage as OrderStage | 'attention')
      : undefined;

  return {
    view: value.view === 'suppliers' ? 'suppliers' : 'orders',
    q: typeof value.q === 'string' ? value.q.slice(0, 200) : '',
    status:
      typeof value.status === 'string' &&
      Object.hasOwn(statusLabels, value.status)
        ? value.status
        : '',
    ...(stage ? { stage } : {}),
  };
}

/** Lists authoritative purchase orders and the workspace supplier directory. */
export function ProcurementPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/procurement/' });
  const navigate = useNavigate({ from: '/app/$organizationId/procurement/' });
  const orders = useQuery(ordersOptions(organizationId));
  const progress = useQuery(progressOptions(organizationId));
  const summaries = progress.data
    ? new Map(progress.data.items.map((item) => [item.id, item]))
    : undefined;
  const suppliers = useQuery(suppliersOptions(organizationId));
  const [dialog, setDialog] = useState<'supplier' | 'order' | null>(null);
  const selected = filters.view === 'orders' ? orders : suppliers;
  const query = filters.q.trim().toLowerCase();
  const visibleOrders = orders.data?.items.filter(
    (o) =>
      (!filters.status || o.status === filters.status) &&
      (!filters.stage ||
        (filters.stage === 'attention'
          ? (summaries?.get(o.id)?.attention ?? 0) > 0
          : summaries?.get(o.id)?.stage === filters.stage)) &&
      [o.reference, o.supplierName, ...o.lines.map((line) => line.sku)]
        .join(' ')
        .toLowerCase()
        .includes(query),
  );
  const visibleSuppliers = suppliers.data?.items.filter((s) =>
    [
      s.name,
      ...s.externalReferences.flatMap((ref) => [ref.system, ref.externalId]),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query),
  );
  const orderCounts = new Map<string, number>();
  for (const order of orders.data?.items ?? [])
    orderCounts.set(
      order.supplierId,
      (orderCounts.get(order.supplierId) ?? 0) + 1,
    );
  const canManage = selected.data?.canManage && !selected.error;
  const waitingCount = progress.data?.items.filter(
    (item) => item.stage === 'awaiting_confirmation',
  ).length;
  const attentionCount = progress.data?.items.filter(
    (item) => item.attention > 0,
  ).length;
  const draftCount = progress.data?.items.filter(
    (item) => item.stage === 'draft',
  ).length;
  const change = (
    next: Partial<Omit<typeof filters, 'stage'>> & {
      stage?: typeof filters.stage | undefined;
    },
  ) => {
    const { stage, ...rest } = { ...filters, ...next };
    void navigate({
      search: { ...rest, ...(stage ? { stage } : {}) },
      replace: true,
    });
  };
  if (selected.error instanceof IdentityError && selected.error.status === 401)
    return <SignInRedirect />;

  return (
    <div className="procurement-page">
      <PageTitle
        title="Procurement"
        actions={
          canManage ? (
            <Button
              onClick={() =>
                setDialog(
                  filters.view === 'suppliers' || !suppliers.data?.items.length
                    ? 'supplier'
                    : 'order',
                )
              }
              disabled={suppliers.isPending || !!suppliers.error}
            >
              <Plus size={16} />
              {filters.view === 'suppliers' || !suppliers.data?.items.length
                ? 'Add supplier'
                : 'New purchase order'}
            </Button>
          ) : null
        }
      />
      <div className="procurement-summary">
        <section
          className="procurement-overview"
          aria-label="Supplier commitments"
        >
          <div className="procurement-overview-heading">
            <PackageCheck size={17} aria-hidden="true" />
            <div>
              <h2>Supplier commitments</h2>
              <p>
                What’s drafted, sent, confirmed and received, and what needs a
                response.
              </p>
            </div>
          </div>
          <div className="procurement-overview-actions">
            {(
              [
                [
                  'attention',
                  attentionCount,
                  'Need a response',
                  'Show orders that need a response',
                ],
                [
                  'awaiting_confirmation',
                  waitingCount,
                  'Waiting on supplier',
                  'Show orders waiting for supplier confirmation',
                ],
                [
                  'draft',
                  draftCount,
                  'Drafts not sent',
                  'Show draft purchase orders',
                ],
              ] as const
            ).map(([stage, count, label, aria]) => (
              <Button
                key={stage}
                variant="ghost"
                aria-label={aria}
                aria-pressed={
                  filters.view === 'orders' && filters.stage === stage
                }
                onClick={() =>
                  change(
                    filters.stage === stage
                      ? { view: 'orders', stage: undefined }
                      : { view: 'orders', q: '', status: '', stage },
                  )
                }
              >
                <strong>{count ?? '—'}</strong>
                <span>{label}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            ))}
          </div>
        </section>
        <ReplenishmentOverview organizationId={organizationId} />
      </div>
      <div className="procurement-collection">
        <CollectionToolbar
          views={
            <CollectionViews
              label="Procurement views"
              value={filters.view}
              views={[
                {
                  value: 'orders',
                  label: 'Purchase orders',
                  icon: <FileText aria-hidden="true" />,
                  count: orders.data?.items.length,
                },
                {
                  value: 'suppliers',
                  label: 'Suppliers',
                  icon: <Building2 aria-hidden="true" />,
                  count: suppliers.data?.items.length,
                },
              ]}
              onChange={(view) => change({ view, q: '', status: '' })}
            />
          }
          search={{
            value: filters.q || undefined,
            onChange: (q) => change({ q: q ?? '' }),
            label:
              filters.view === 'orders'
                ? 'Search purchase orders'
                : 'Search suppliers',
            placeholder:
              filters.view === 'orders'
                ? 'Search orders, suppliers, or SKUs…'
                : 'Search suppliers…',
            maxLength: 200,
          }}
          filters={
            filters.view === 'orders'
              ? [
                  {
                    kind: 'choice',
                    key: 'stage',
                    label: 'Stage',
                    icon: CircleDot,
                    value:
                      filters.stage ??
                      (filters.status ? `status:${filters.status}` : undefined),
                    options: stageOptions(filters.status),
                    onChange: (value) =>
                      change(
                        value?.startsWith('status:')
                          ? { status: value.slice(7), stage: undefined }
                          : {
                              status: '',
                              stage: stageFilters.find(
                                (stage) => stage === value,
                              ),
                            },
                      ),
                  },
                ]
              : []
          }
          onClear={() => change({ q: '', status: '', stage: undefined })}
          onRefresh={() => {
            void orders.refetch();
            void suppliers.refetch();
          }}
          refreshing={orders.isFetching || suppliers.isFetching}
          refreshLabel="Refresh procurement"
        />
        {selected.isPending ? (
          <div className="procurement-loading" role="status">
            Loading procurement records…
          </div>
        ) : selected.error ? (
          <Alert role="alert" tone="danger">
            {procurementError(selected.error)}
            <Button variant="outline" onClick={() => void selected.refetch()}>
              Retry
            </Button>
          </Alert>
        ) : filters.view === 'orders' ? (
          <>
            {!visibleOrders?.length ? (
              <Empty>
                <FileText size={30} />
                <h3>
                  {orders.data?.items.length
                    ? 'No matching purchase orders'
                    : 'Your first order starts with a supplier'}
                </h3>
                <p>
                  {orders.data?.items.length
                    ? 'Try a different search or status.'
                    : 'Add a supplier, create a draft, then track every status change here.'}
                </p>
                {filters.q || filters.status || filters.stage ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      change({ q: '', status: '', stage: undefined })
                    }
                  >
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button
                    variant="outline"
                    disabled={suppliers.isPending || !!suppliers.error}
                    onClick={() =>
                      setDialog(
                        suppliers.data?.items.length ? 'order' : 'supplier',
                      )
                    }
                  >
                    {suppliers.data?.items.length
                      ? 'Create purchase order'
                      : 'Add your first supplier'}
                  </Button>
                ) : (
                  <p>
                    Your role doesn’t include Manage procurement, so you can’t
                    create purchase orders.
                  </p>
                )}
              </Empty>
            ) : (
              <DataTable
                caption="Purchase orders"
                columns={orderColumns(organizationId, summaries)}
                rows={visibleOrders}
                rowKey={(order) => order.id}
              />
            )}
          </>
        ) : !visibleSuppliers?.length ? (
          <Empty>
            <Building2 size={30} />
            <h3>
              {suppliers.data?.items.length
                ? 'No matching suppliers'
                : 'Build your supplier directory'}
            </h3>
            <p>
              {suppliers.data?.items.length
                ? 'Try another name or external reference.'
                : 'Start with a name. Add an external reference when the supplier also exists in another system.'}
            </p>
            {filters.q ? (
              <Button variant="outline" onClick={() => change({ q: '' })}>
                Clear search
              </Button>
            ) : (
              canManage && (
                <Button variant="outline" onClick={() => setDialog('supplier')}>
                  Add your first supplier
                </Button>
              )
            )}
          </Empty>
        ) : (
          <DataTable
            caption="Suppliers"
            columns={supplierColumns({
              organizationId,
              orderCount: (supplier) =>
                orders.data ? (orderCounts.get(supplier.id) ?? 0) : undefined,
              showOrders: (supplier) =>
                change({ view: 'orders', q: supplier.name, status: '' }),
            })}
            rows={visibleSuppliers}
            rowKey={(supplier) => supplier.id}
          />
        )}
      </div>
      {suppliers.error && filters.view === 'orders' && (
        <Alert tone="warning">
          Suppliers could not be loaded.{' '}
          <Button variant="ghost" onClick={() => void suppliers.refetch()}>
            Retry suppliers
          </Button>
        </Alert>
      )}
      {dialog === 'supplier' && (
        <SupplierDialog
          organizationId={organizationId}
          close={() => setDialog(null)}
        />
      )}
      {dialog === 'order' && suppliers.data && (
        <OrderDialog
          organizationId={organizationId}
          suppliers={suppliers.data.items}
          close={() => setDialog(null)}
          saved={(order) => {
            setDialog(null);
            void navigate({
              to: '/app/$organizationId/procurement/$purchaseOrderId',
              params: { organizationId, purchaseOrderId: order.id },
            });
          }}
        />
      )}
    </div>
  );
}
