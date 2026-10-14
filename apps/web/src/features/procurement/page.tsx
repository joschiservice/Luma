import './procurement.css';

import type { PurchaseOrderList } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowUpRight,
  Building2,
  FileText,
  PackageCheck,
  Plus,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { allSuppliersOptions } from '../../shared/procurement/suppliers';
import {
  ordersOptions,
  type ProcurementSearch,
  procurementTab,
  suppliersOptions,
} from './data';
import { OrderDialog, SupplierDialog } from './forms';
import { PurchaseOrdersList } from './orders-list';
import { purchasingOptions } from './purchasing-data';
import { PurchasingWorkbench } from './purchasing-workbench';
import { ReplenishmentOverview } from './replenishment-overview';
import { SuppliersList } from './suppliers-list';

type Counts = PurchaseOrderList['counts'];

/** The overview's count buttons, each opening a built-in purchase-order view. */
const overviewViews = [
  {
    segment: 'attention',
    count: (counts: NonNullable<Counts>) => counts.attention,
    label: m.procurement_overview_attention,
    aria: m.procurement_overview_attention_label,
  },
  {
    segment: 'awaiting_confirmation',
    count: (counts: NonNullable<Counts>) =>
      counts.stages.awaiting_confirmation ?? 0,
    label: m.procurement_overview_waiting,
    aria: m.procurement_overview_waiting_label,
  },
  {
    segment: 'draft',
    count: (counts: NonNullable<Counts>) => counts.stages.draft ?? 0,
    label: m.procurement_overview_drafts,
    aria: m.procurement_overview_drafts_label,
  },
] as const;

/**
 * Whether the URL shows the first page of All purchase orders without search, conditions or
 * grouping: that read carries the workspace counts, so the overview needs no read of its own.
 */
function unfilteredOrders(search: ProcurementSearch) {
  return (
    procurementTab(search) === 'orders' &&
    (search.view ?? 'all') === 'all' &&
    !search.where?.conditions.length &&
    !search.group &&
    !search.q &&
    !search.cursor
  );
}

/**
 * The procurement page: supplier commitments with counts that open built-in views, then the
 * purchase-order list, the supplier list or the purchasing workbench. Both lists are
 * configurable views; the URL holds the tab, the view and the page position.
 */
export function ProcurementPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const search = useSearch({ from: '/app/$organizationId/procurement/' });
  const navigate = useNavigate({ from: '/app/$organizationId/procurement/' });
  const tab = procurementTab(search);
  const counted = unfilteredOrders(search);
  const [listCounts, setListCounts] = useState<Counts>(null);
  const overview = useQuery({
    ...ordersOptions(organizationId, { limit: 1 }),
    enabled: !counted,
  });
  const counts = (counted ? listCounts : overview.data?.counts) ?? undefined;
  const directorySize = useQuery(
    suppliersOptions(organizationId, { limit: 1, count: 'exact' }),
  );
  const supplierCount = directorySize.data?.totalCount ?? undefined;
  const purchasing = useQuery(
    purchasingOptions(organizationId, search.demandPeriodDays ?? 30),
  );
  const [dialog, setDialog] = useState<'supplier' | 'order' | null>(null);
  const directory = useQuery({
    ...allSuppliersOptions(organizationId),
    enabled: dialog === 'order',
  });
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const canManage = directorySize.data?.canManage ?? false;
  const hasSuppliers = (supplierCount ?? 0) > 0;
  const go = (next: ProcurementSearch) =>
    void navigate({ search: next, resetScroll: false });
  const openDialog = (
    event: { currentTarget: HTMLButtonElement },
    kind: 'supplier' | 'order',
  ) => {
    dialogTrigger.current = event.currentTarget;
    setDialog(kind);
  };

  const tabs = (
    <CollectionViews
      label={m.procurement_list_views()}
      value={tab}
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
          value: 'orders' as const,
          label: m.procurement_list_view_orders(),
          icon: <FileText aria-hidden="true" />,
          count: counts?.all,
        },
        {
          value: 'suppliers' as const,
          label: m.procurement_list_view_suppliers(),
          icon: <Building2 aria-hidden="true" />,
          count: supplierCount,
        },
      ]}
      // Each list opens the member's remembered view for it.
      onChange={(next) => go(next === 'orders' ? {} : { tab: next })}
    />
  );

  return (
    <div className="procurement-page">
      <PageTitle
        title={m.procurement_title()}
        actions={
          canManage ? (
            <Button
              onClick={(event) =>
                openDialog(
                  event,
                  tab === 'suppliers' || !hasSuppliers ? 'supplier' : 'order',
                )
              }
              disabled={directorySize.isPending || !!directorySize.error}
            >
              <Plus size={16} />
              {tab === 'suppliers' || !hasSuppliers
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
            {overviewViews.map((item) => {
              const pressed = tab === 'orders' && search.view === item.segment;

              return (
                <Button
                  key={item.segment}
                  variant="ghost"
                  aria-label={item.aria()}
                  aria-pressed={pressed}
                  onClick={() => go({ view: pressed ? 'all' : item.segment })}
                >
                  <strong>
                    {counts
                      ? formatNumber(item.count(counts))
                      : m.common_empty_value()}
                  </strong>
                  <span>{item.label()}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Button>
              );
            })}
          </div>
        </section>
        <ReplenishmentOverview organizationId={organizationId} />
      </div>
      <div className="procurement-collection">
        {tab === 'purchasing' ? (
          <>
            <CollectionToolbar
              views={tabs}
              search={{
                value: search.q,
                onChange: (q) => go({ ...search, q: q || undefined }),
                label: m.purchasing_search_label(),
                placeholder: m.purchasing_search_placeholder(),
                maxLength: 200,
              }}
              onClear={() => go({ ...search, q: undefined })}
              onRefresh={() => void purchasing.refetch()}
              refreshing={purchasing.isFetching}
              refreshLabel={m.procurement_list_refresh()}
            />
            <PurchasingWorkbench
              organizationId={organizationId}
              search={search.q ?? ''}
              period={search.demandPeriodDays ?? 30}
              onPeriod={(demandPeriodDays) =>
                go({ ...search, demandPeriodDays })
              }
            />
          </>
        ) : tab === 'suppliers' ? (
          <SuppliersList
            organizationId={organizationId}
            search={search}
            tabs={tabs}
            empty={
              <Empty>
                <Building2 size={30} aria-hidden="true" />
                <h3>{m.procurement_list_suppliers_empty_title()}</h3>
                <p>{m.procurement_list_suppliers_empty_body()}</p>
                {canManage ? (
                  <Button
                    variant="outline"
                    onClick={(event) => openDialog(event, 'supplier')}
                  >
                    {m.procurement_list_add_first_supplier()}
                  </Button>
                ) : null}
              </Empty>
            }
          />
        ) : (
          <PurchaseOrdersList
            organizationId={organizationId}
            search={search}
            tabs={tabs}
            onCounts={setListCounts}
            empty={
              <Empty>
                <FileText size={30} aria-hidden="true" />
                <h3>{m.procurement_list_orders_empty_title()}</h3>
                <p>{m.procurement_list_orders_empty_body()}</p>
                {canManage ? (
                  <Button
                    variant="outline"
                    disabled={directorySize.isPending || !!directorySize.error}
                    onClick={(event) =>
                      openDialog(event, hasSuppliers ? 'order' : 'supplier')
                    }
                  >
                    {hasSuppliers
                      ? m.procurement_list_create_order()
                      : m.procurement_list_add_first_supplier()}
                  </Button>
                ) : directorySize.data ? (
                  <p>{m.procurement_list_no_permission()}</p>
                ) : null}
              </Empty>
            }
          />
        )}
      </div>
      {directorySize.error && tab === 'orders' && (
        <Alert tone="warning">
          {m.procurement_list_suppliers_failed()}{' '}
          <Button variant="ghost" onClick={() => void directorySize.refetch()}>
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
      {dialog === 'order' && directory.data && (
        <OrderDialog
          organizationId={organizationId}
          returnFocus={dialogTrigger}
          suppliers={directory.data.items}
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
