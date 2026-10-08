import type { OrderListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  statusLabels,
} from './presentation';

/** Shows the order's identity, state labels and key dates as the page heading. */
export function OrderHeader({ order }: { order: OrderListItem }) {
  return (
    <header className="order-head">
      <p className="order-eyebrow">
        {m.orders_header_eyebrow({ id: order.id })}
      </p>
      <h1>{orderLabel(order)}</h1>
      <div className="order-pills">
        {order.issueIds.length ? (
          <StatePill state="attention">{m.orders_flag_needs_you()}</StatePill>
        ) : null}
        {order.overdue ? (
          <Badge tone="danger">{m.orders_flag_overdue()}</Badge>
        ) : null}
        <Badge>{statusLabels[order.status] ?? order.status}</Badge>
        <Badge>
          {paymentLabels[order.paymentStatus] ?? order.paymentStatus}
        </Badge>
        <Badge tone="info">{fulfillmentLabel(order)}</Badge>
        {order.differs ? (
          <Badge tone="warning">{m.orders_flag_differs()}</Badge>
        ) : null}
      </div>
      <p className="order-meta">
        {order.placedAt ? (
          <span>
            {rich(m.orders_header_placed, {
              date: <WorkspaceDate value={order.placedAt} />,
            })}
          </span>
        ) : null}
        {order.total ? (
          <span>
            {m.orders_header_total({ amount: formatMoney(order.total) ?? '' })}
          </span>
        ) : null}
        {order.dueAt ? (
          <span>
            {rich(m.orders_header_due, {
              date: <WorkspaceDate value={order.dueAt} />,
            })}
          </span>
        ) : null}
        <span>
          {rich(m.orders_header_read, {
            date: <WorkspaceDate value={order.observedAt} />,
          })}
        </span>
      </p>
    </header>
  );
}
