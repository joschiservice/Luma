import type { OrderDetail, OrderListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import {
  type RecordFact,
  RecordHeader,
} from '@luma/ui/components/workspace/record-header';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Banknote,
  CalendarClock,
  CalendarDays,
  CircleDot,
  CreditCard,
  RefreshCw,
  Truck,
} from 'lucide-react';

import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import type { OrdersSearch } from './data';

const paymentTones: Partial<Record<string, RecordFact['tone']>> = {
  failed: 'danger',
  refunded: 'warning',
  partially_refunded: 'warning',
  unknown: 'warning',
};

function orderFacts(order: OrderListItem): RecordFact[] {
  return [
    {
      key: 'status',
      icon: CircleDot,
      label: m.orders_fact_status(),
      value: statusLabels[order.status] ?? order.status,
      tone: order.status === 'unknown' ? 'warning' : undefined,
    },
    {
      key: 'payment',
      icon: CreditCard,
      label: m.orders_fact_payment(),
      value: paymentLabels[order.paymentStatus] ?? order.paymentStatus,
      tone: paymentTones[order.paymentStatus],
    },
    {
      key: 'fulfillment',
      icon: Truck,
      label: m.orders_fact_fulfillment(),
      value: fulfillmentLabel(order),
      tone:
        order.open !== false && order.fulfillment === 'partial'
          ? 'warning'
          : undefined,
    },
    {
      key: 'total',
      icon: Banknote,
      label: m.orders_fact_total(),
      value: formatMoney(order.total) ?? m.common_not_reported(),
    },
    {
      key: 'placed',
      icon: CalendarDays,
      label: m.orders_fact_placed(),
      value: order.placedAt ? (
        <WorkspaceDate value={order.placedAt} />
      ) : (
        m.common_not_reported()
      ),
    },
    ...(order.dueAt
      ? [
          {
            key: 'due',
            icon: CalendarClock,
            // The label says it in words, so the highlight doesn't rely on color alone.
            label: order.overdue
              ? m.orders_fact_overdue_since()
              : m.orders_fact_due(),
            value: <WorkspaceDate value={order.dueAt} />,
            tone: order.overdue ? ('danger' as const) : undefined,
          },
        ]
      : []),
    {
      key: 'read',
      icon: RefreshCw,
      label: m.orders_fact_read(),
      value: <WorkspaceDate value={order.observedAt} />,
    },
  ];
}

/**
 * Names the order in the workspace breadcrumb and opens the page with its key facts. Current
 * state below says what needs attention, so the header doesn't repeat it as flags. Without
 * `detail`, only the breadcrumb is shown. `returnPath` is the record the reader came from.
 */
export function OrderHeader({
  organizationId,
  search,
  returnPath,
  detail,
}: {
  organizationId: string;
  search: OrdersSearch;
  returnPath: string | null;
  detail?: OrderDetail | undefined;
}) {
  const order = detail?.order;
  const needsYou = detail?.issues.find((issue) => issue.needsYou);

  return (
    <RecordHeader
      section={{
        label: m.orders_page_title(),
        domain: 'orders',
        link: (
          <Link
            to="/app/$organizationId/orders"
            params={{ organizationId }}
            search={search}
          />
        ),
      }}
      title={order ? orderLabel(order) : m.orders_detail_title_fallback()}
      back={returnPath ? <a href={returnPath} /> : undefined}
      actions={
        needsYou ? (
          <Link
            className={buttonVariants({ size: 'sm' })}
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{ organizationId, exceptionId: needsYou.id }}
            search={{ view: 'needs_you' }}
          >
            {m.orders_inspector_review_issue()}
            <ArrowRight aria-hidden="true" />
          </Link>
        ) : null
      }
      facts={order ? orderFacts(order) : []}
    />
  );
}
