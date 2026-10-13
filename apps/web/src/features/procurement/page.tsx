import './procurement.css';

import {
  type OrderStage,
  orderStageSchema,
  type OrderSummary,
  type PurchaseOrder,
  type Supplier,
} from '@luma/api-contract';
import { formatList, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
import { useRef, useState } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
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
import { purchasingOptions } from './purchasing-data';
import { PurchasingWorkbench } from './purchasing-workbench';
import { ReplenishmentOverview } from './replenishment-overview';

function orderColumns(
  organizationId: string,
  progress: Map<string, OrderSummary> | undefined,
): DataTableColumn<PurchaseOrder>[] {
  return [
    {
      key: 'reference',
      header: m.procurement_column_purchase_order(),
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
            {m.procurement_lines_count({ count: order.lines.length })}
            {progress?.get(order.id)?.externalOrderNumber
              ? ` · ${m.procurement_erp_order_number({ number: progress.get(order.id)!.externalOrderNumber! })}`
              : ''}
          </small>
        </span>
      ),
    },
    {
      key: 'supplier',
      header: m.procurement_column_supplier(),
      cell: (order) => order.supplierName,
    },
    {
      key: 'stage',
      header: m.procurement_column_stage(),
      cell: (order) => {
        const summary = progress?.get(order.id);

        return summary ? (
          <span className="procurement-flags">
            <StagePill stage={summary.stage} />
            {summary.attention ? (
              <Badge tone={summary.overdue ? 'danger' : 'warning'}>
                {summary.overdue
                  ? m.procurement_overdue()
                  : m.procurement_to_answer({ count: summary.attention })}
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
      header: m.procurement_column_expected(),
      hideOnNarrow: true,
      cell: (order) => {
        const date = progress?.get(order.id)?.expectedDate;

        return date ? (
          calendarDate(date)
        ) : (
          <span className="procurement-muted">{m.common_empty_value()}</span>
        );
      },
    },
    {
      key: 'next',
      header: m.procurement_column_owner(),
      hideOnNarrow: true,
      cell: (order) => {
        const owner = progress?.get(order.id)?.nextOwner;

        return owner ? ownerLabels[owner]() : m.common_empty_value();
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
      header: m.procurement_column_supplier(),
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
      header: m.procurement_column_link(),
      hideOnNarrow: true,
      cell: (supplier) =>
        supplier.link ? (
          <StatePill state="verified">
            {supplier.link.name ??
              m.procurement_supplier_external({
                id: supplier.link.externalId,
              })}
          </StatePill>
        ) : (
          <span className="procurement-muted">
            {m.procurement_not_linked()}
          </span>
        ),
    },
    {
      key: 'references',
      header: m.procurement_column_references(),
      hideOnNarrow: true,
      cell: (supplier) =>
        supplier.externalReferences.length
          ? formatList(
              supplier.externalReferences.map(
                (ref) => `${ref.system} · ${ref.externalId}`,
              ),
            )
          : m.common_none(),
    },
    {
      key: 'added',
      header: m.procurement_column_added(),
      hideOnNarrow: true,
      cell: (supplier) => <WorkspaceDate value={supplier.createdAt} />,
    },
    {
      key: 'orders',
      header: m.procurement_column_orders(),
      numeric: true,
      cell: (supplier) => {
        const count = orderCount(supplier);

        return count === undefined
          ? m.common_empty_value()
          : formatNumber(count);
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">{m.common_actions()}</span>,
      cell: (supplier) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={m.procurement_list_show_supplier_orders({
            supplier: supplier.name,
          })}
          title={m.procurement_list_show_orders()}
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
    { value: 'attention', label: m.procurement_list_filter_attention() },
    ...orderStageSchema.options.map((value) => ({
      value,
      label: stages[value].label,
    })),
    ...(legacy ? [{ value: `status:${legacy[0]}`, label: legacy[1]() }] : []),
  ];
}

/** Keeps procurement views and filters shareable without accepting unsupported statuses. */
export function parseProcurementSearch(value: Record<string, unknown>): {
  view: 'orders' | 'suppliers' | 'purchasing';
  demandPeriodDays?: number;
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
    view:
      value.view === 'purchasing'
        ? 'purchasing'
        : value.view === 'suppliers'
          ? 'suppliers'
          : 'orders',
    ...([7, 30, 60, 90, 180].includes(Number(value.demandPeriodDays))
      ? { demandPeriodDays: Number(value.demandPeriodDays) }
      : {}),
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
  const purchasing = useQuery(
    purchasingOptions(organizationId, filters.demandPeriodDays ?? 30),
  );
  const [dialog, setDialog] = useState<'supplier' | 'order' | null>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
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
        title={m.procurement_title()}
        actions={
          canManage ? (
            <Button
              onClick={(event) => {
                dialogTrigger.current = event.currentTarget;
                setDialog(
                  filters.view === 'suppliers' || !suppliers.data?.items.length
                    ? 'supplier'
                    : 'order',
                );
              }}
              disabled={suppliers.isPending || !!suppliers.error}
            >
              <Plus size={16} />
              {filters.view === 'suppliers' || !suppliers.data?.items.length
                ? m.procurement_list_add_supplier()
                : m.procurement_list_new_order()}
            </Button>
          ) : null
        }
      />
      <div className="procurement-summary">
        <section
          className="procurement-overview"
          aria-label={m.procurement_overview_title()}
        >
          <div className="procurement-overview-heading">
            <PackageCheck size={17} aria-hidden="true" />
            <div>
              <h2>{m.procurement_overview_title()}</h2>
              <p>{m.procurement_overview_description()}</p>
            </div>
          </div>
          <div className="procurement-overview-actions">
            {(
              [
                [
                  'attention',
                  attentionCount,
                  m.procurement_overview_attention,
                  m.procurement_overview_attention_label,
                ],
                [
                  'awaiting_confirmation',
                  waitingCount,
                  m.procurement_overview_waiting,
                  m.procurement_overview_waiting_label,
                ],
                [
                  'draft',
                  draftCount,
                  m.procurement_overview_drafts,
                  m.procurement_overview_drafts_label,
                ],
              ] as const
            ).map(([stage, count, label, aria]) => (
              <Button
                key={stage}
                variant="ghost"
                aria-label={aria()}
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
                <strong>
                  {count === undefined
                    ? m.common_empty_value()
                    : formatNumber(count)}
                </strong>
                <span>{label()}</span>
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
              label={m.procurement_list_views()}
              value={filters.view}
              views={[
                ...(purchasing.data?.enabled
                  ? [
                      {
                        value: 'purchasing' as const,
                        label: m.purchasing_title(),
                        icon: <PackageCheck aria-hidden="true" />,
                      },
                    ]
                  : []),
                {
                  value: 'orders',
                  label: m.procurement_list_view_orders(),
                  icon: <FileText aria-hidden="true" />,
                  count: orders.data?.items.length,
                },
                {
                  value: 'suppliers',
                  label: m.procurement_list_view_suppliers(),
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
              filters.view === 'purchasing'
                ? m.purchasing_search_label()
                : filters.view === 'orders'
                  ? m.procurement_list_search_orders()
                  : m.procurement_list_search_suppliers(),
            placeholder:
              filters.view === 'purchasing'
                ? m.purchasing_search_placeholder()
                : filters.view === 'orders'
                  ? m.procurement_list_search_orders_placeholder()
                  : m.procurement_list_search_suppliers_placeholder(),
            maxLength: 200,
          }}
          filters={
            filters.view === 'orders'
              ? [
                  {
                    kind: 'choice',
                    key: 'stage',
                    label: m.procurement_list_filter_stage(),
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
            if (filters.view === 'purchasing') void purchasing.refetch();
          }}
          refreshing={
            orders.isFetching ||
            suppliers.isFetching ||
            (filters.view === 'purchasing' && purchasing.isFetching)
          }
          refreshLabel={m.procurement_list_refresh()}
        />
        {filters.view === 'purchasing' ? (
          <PurchasingWorkbench
            organizationId={organizationId}
            search={filters.q}
            period={filters.demandPeriodDays ?? 30}
            onPeriod={(demandPeriodDays) => change({ demandPeriodDays })}
          />
        ) : selected.isPending ? (
          <div className="procurement-loading" role="status">
            {filters.view === 'orders'
              ? m.procurement_list_loading_orders()
              : m.procurement_list_loading_suppliers()}
          </div>
        ) : selected.error ? (
          <Alert role="alert" tone="danger">
            {procurementError(selected.error)}
            <Button variant="outline" onClick={() => void selected.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : filters.view === 'orders' ? (
          <>
            {!visibleOrders?.length ? (
              <Empty>
                <FileText size={30} />
                <h3>
                  {orders.data?.items.length
                    ? m.procurement_list_orders_filtered_title()
                    : m.procurement_list_orders_empty_title()}
                </h3>
                <p>
                  {orders.data?.items.length
                    ? m.procurement_list_orders_filtered_body()
                    : m.procurement_list_orders_empty_body()}
                </p>
                {filters.q || filters.status || filters.stage ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      change({ q: '', status: '', stage: undefined })
                    }
                  >
                    {m.common_clear_filters()}
                  </Button>
                ) : canManage ? (
                  <Button
                    variant="outline"
                    disabled={suppliers.isPending || !!suppliers.error}
                    onClick={(event) => {
                      dialogTrigger.current = event.currentTarget;
                      setDialog(
                        suppliers.data?.items.length ? 'order' : 'supplier',
                      );
                    }}
                  >
                    {suppliers.data?.items.length
                      ? m.procurement_list_create_order()
                      : m.procurement_list_add_first_supplier()}
                  </Button>
                ) : (
                  <p>{m.procurement_list_no_permission()}</p>
                )}
              </Empty>
            ) : (
              <DataTable
                caption={m.procurement_list_view_orders()}
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
                ? m.procurement_list_suppliers_filtered_title()
                : m.procurement_list_suppliers_empty_title()}
            </h3>
            <p>
              {suppliers.data?.items.length
                ? m.procurement_list_suppliers_filtered_body()
                : m.procurement_list_suppliers_empty_body()}
            </p>
            {filters.q ? (
              <Button variant="outline" onClick={() => change({ q: '' })}>
                {m.procurement_list_clear_search()}
              </Button>
            ) : (
              canManage && (
                <Button
                  variant="outline"
                  onClick={(event) => {
                    dialogTrigger.current = event.currentTarget;
                    setDialog('supplier');
                  }}
                >
                  {m.procurement_list_add_first_supplier()}
                </Button>
              )
            )}
          </Empty>
        ) : (
          <DataTable
            caption={m.procurement_list_view_suppliers()}
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
          {m.procurement_list_suppliers_failed()}{' '}
          <Button variant="ghost" onClick={() => void suppliers.refetch()}>
            {m.procurement_list_suppliers_retry()}
          </Button>
        </Alert>
      )}
      {dialog === 'supplier' && (
        <SupplierDialog
          organizationId={organizationId}
          returnFocus={dialogTrigger}
          close={() => setDialog(null)}
        />
      )}
      {dialog === 'order' && suppliers.data && (
        <OrderDialog
          organizationId={organizationId}
          returnFocus={dialogTrigger}
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
