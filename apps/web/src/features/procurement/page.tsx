import './procurement.css';

import type { PurchaseOrder, Supplier } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
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
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
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
  FileText,
  PackageCheck,
  Plus,
  Search,
} from 'lucide-react';
import { useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { ordersOptions, procurementError, suppliersOptions } from './data';
import { OrderDialog, SupplierDialog } from './forms';
import { OrderStatus, statusLabels } from './presentation';

function orderColumns(
  organizationId: string,
): DataTableColumn<PurchaseOrder>[] {
  return [
    {
      key: 'reference',
      header: 'Purchase order',
      cell: (order) => (
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
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      cell: (order) => order.supplierName,
    },
    {
      key: 'lines',
      header: 'Lines',
      numeric: true,
      hideOnNarrow: true,
      cell: (order) => order.lines.length,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (order) => <OrderStatus status={order.status} />,
    },
    {
      key: 'ownership',
      header: 'Ownership',
      hideOnNarrow: true,
      cell: (order) =>
        order.authority === 'luma' ? 'Luma-owned' : 'Externally owned',
    },
  ];
}

function supplierColumns({
  orderCount,
  showOrders,
}: {
  orderCount: (supplier: Supplier) => number | undefined;
  showOrders: (supplier: Supplier) => void;
}): DataTableColumn<Supplier>[] {
  return [
    { key: 'name', header: 'Supplier', cell: (supplier) => supplier.name },
    {
      key: 'references',
      header: 'External references',
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

/** Keeps procurement views and filters shareable without accepting unsupported statuses. */
export function parseProcurementSearch(value: Record<string, unknown>): {
  view: 'orders' | 'suppliers';
  q: string;
  status: string;
} {
  return {
    view: value.view === 'suppliers' ? 'suppliers' : 'orders',
    q: typeof value.q === 'string' ? value.q.slice(0, 200) : '',
    status:
      typeof value.status === 'string' &&
      Object.hasOwn(statusLabels, value.status)
        ? value.status
        : '',
  };
}

/** Lists authoritative purchase orders and the workspace supplier directory. */
export function ProcurementPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/procurement/' });
  const navigate = useNavigate({ from: '/app/$organizationId/procurement/' });
  const orders = useQuery(ordersOptions(organizationId));
  const suppliers = useQuery(suppliersOptions(organizationId));
  const [dialog, setDialog] = useState<'supplier' | 'order' | null>(null);
  const selected = filters.view === 'orders' ? orders : suppliers;
  const query = filters.q.trim().toLowerCase();
  const visibleOrders = orders.data?.items.filter(
    (o) =>
      (!filters.status || o.status === filters.status) &&
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
  const openCount = orders.data?.items.filter(
    (order) => order.status === 'open',
  ).length;
  const draftCount = orders.data?.items.filter(
    (order) => order.status === 'draft',
  ).length;
  const change = (next: Partial<typeof filters>) =>
    void navigate({ search: { ...filters, ...next }, replace: true });
  if (selected.error instanceof IdentityError && selected.error.status === 401)
    return <SignInRedirect />;

  return (
    <div className="procurement-page">
      <PageHeader
        icon={<DomainIcon domain="procurement" size="lg" />}
        title="Procurement"
        description="Suppliers and purchase orders, with ownership and status history in one place."
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
      <section
        className="procurement-overview"
        aria-label="Replenishment context"
      >
        <div className="procurement-overview-heading">
          <PackageCheck size={17} aria-hidden="true" />
          <div>
            <h2>Replenishment context</h2>
            <p>
              Find supplier and order state before creating another commitment.
            </p>
          </div>
        </div>
        <div className="procurement-overview-actions">
          <Button
            variant="ghost"
            aria-label="Show open purchase orders"
            aria-pressed={
              filters.view === 'orders' && filters.status === 'open'
            }
            onClick={() => change({ view: 'orders', q: '', status: 'open' })}
          >
            <strong>{openCount ?? '—'}</strong>
            <span>Open orders</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            aria-label="Show draft purchase orders"
            aria-pressed={
              filters.view === 'orders' && filters.status === 'draft'
            }
            onClick={() => change({ view: 'orders', q: '', status: 'draft' })}
          >
            <strong>{draftCount ?? '—'}</strong>
            <span>Drafts to review</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            aria-label="Show suppliers"
            aria-pressed={filters.view === 'suppliers'}
            onClick={() => change({ view: 'suppliers', q: '', status: '' })}
          >
            <strong>{suppliers.data?.items.length ?? '—'}</strong>
            <span>Suppliers</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </Button>
        </div>
      </section>
      <div className="procurement-collection">
        <CollectionToolbar
          views={
            <div
              className="procurement-views"
              role="group"
              aria-label="Procurement views"
            >
              {(['orders', 'suppliers'] as const).map((view) => (
                <Button
                  key={view}
                  variant="ghost"
                  aria-pressed={filters.view === view}
                  onClick={() => change({ view, q: '', status: '' })}
                >
                  {view === 'orders' ? (
                    <FileText size={15} />
                  ) : (
                    <Building2 size={15} />
                  )}{' '}
                  {view === 'orders' ? 'Purchase orders' : 'Suppliers'}
                  <span>
                    {(view === 'orders' ? orders.data : suppliers.data)?.items
                      .length ?? '—'}
                  </span>
                </Button>
              ))}
            </div>
          }
          onRefresh={() => {
            void orders.refetch();
            void suppliers.refetch();
          }}
          refreshing={orders.isFetching || suppliers.isFetching}
          children={
            <div className="procurement-filters">
              <div className="procurement-search">
                <Search size={15} aria-hidden="true" />
                <Input
                  aria-label={
                    filters.view === 'orders'
                      ? 'Search purchase orders'
                      : 'Search suppliers'
                  }
                  placeholder={
                    filters.view === 'orders'
                      ? 'Search orders, suppliers, or SKUs…'
                      : 'Search suppliers…'
                  }
                  value={filters.q}
                  onChange={(e) => change({ q: e.target.value })}
                />
              </div>
              {filters.view === 'orders' && (
                <Select
                  aria-label="Order status"
                  value={filters.status}
                  options={[
                    { value: '', label: 'All statuses' },
                    ...Object.entries(statusLabels).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  ]}
                  onValueChange={(value) => change({ status: value ?? '' })}
                />
              )}
            </div>
          }
        />
        {selected.isPending ? (
          <div className="procurement-loading" role="status">
            Loading procurement records…
          </div>
        ) : selected.error ? (
          <div className="procurement-notice">
            <Alert role="alert" tone="danger">
              {procurementError(selected.error)}
              <Button variant="outline" onClick={() => void selected.refetch()}>
                Retry
              </Button>
            </Alert>
          </div>
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
                {filters.q || filters.status ? (
                  <Button
                    variant="outline"
                    onClick={() => change({ q: '', status: '' })}
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
                  <p>An owner or admin can create purchase orders.</p>
                )}
              </Empty>
            ) : (
              <DataTable
                caption="Purchase orders"
                variant="plain"
                columns={orderColumns(organizationId)}
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
            variant="plain"
            columns={supplierColumns({
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
