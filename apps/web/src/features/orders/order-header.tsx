import type { OrderDetail, OrderListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { StatePill } from '@luma/ui/components/primitives/state';
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
  Check,
  CircleDot,
  CreditCard,
  Link2,
  RefreshCw,
  Truck,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { OrdersSearch } from './data';
import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  statusLabels,
} from './presentation';

function orderFacts(order: OrderListItem): RecordFact[] {
  return [
    {
      key: 'status',
      icon: CircleDot,
      label: m.orders_fact_status(),
      value: statusLabels[order.status] ?? order.status,
    },
    {
      key: 'payment',
      icon: CreditCard,
      label: m.orders_fact_payment(),
      value: paymentLabels[order.paymentStatus] ?? order.paymentStatus,
    },
    {
      key: 'fulfillment',
      icon: Truck,
      label: m.orders_fact_fulfillment(),
      value: fulfillmentLabel(order),
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
            label: m.orders_fact_due(),
            value: <WorkspaceDate value={order.dueAt} />,
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

/** Copies the order's address and briefly confirms it in the button and to assistive technology. */
function CopyLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);

    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied
    ? m.orders_inspector_link_copied()
    : m.orders_inspector_copy_link();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.orders_inspector_copy_link()}
        title={label}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(new URL(path, window.location.origin).href)
            .then(() => setCopied(true));
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
      </Button>
      <span role="status" className="sr-only">
        {copied ? m.orders_inspector_link_copied() : ''}
      </span>
    </>
  );
}

/**
 * Names the order in the workspace breadcrumb and opens the page with its attention flags and
 * key facts. Without `detail`, only the breadcrumb is shown. `returnPath` is the record the
 * reader came from; `here` is the order's own path.
 */
export function OrderHeader({
  organizationId,
  search,
  returnPath,
  detail,
  here,
}: {
  organizationId: string;
  search: OrdersSearch;
  returnPath: string | null;
  detail?: OrderDetail | undefined;
  here: string;
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
        order ? (
          <>
            {needsYou ? (
              <Link
                className={buttonVariants({ size: 'sm' })}
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: needsYou.id }}
                search={{ view: 'needs_you' }}
              >
                {m.orders_inspector_review_issue()}
                <ArrowRight aria-hidden="true" />
              </Link>
            ) : null}
            <CopyLink path={here} />
          </>
        ) : null
      }
      status={
        order ? (
          <>
            {order.issueIds.length ? (
              <StatePill state="attention">
                {m.orders_flag_needs_you()}
              </StatePill>
            ) : null}
            {order.overdue ? (
              <Badge tone="danger">{m.orders_flag_overdue()}</Badge>
            ) : null}
            {order.differs ? (
              <Badge tone="warning">{m.orders_flag_differs()}</Badge>
            ) : null}
          </>
        ) : null
      }
      facts={order ? orderFacts(order) : []}
    />
  );
}
