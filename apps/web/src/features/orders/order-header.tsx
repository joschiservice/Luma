import type { OrderListItem } from '@luma/api-contract';
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
      <p className="order-eyebrow">Order · {order.id}</p>
      <h1>{orderLabel(order)}</h1>
      <div className="order-pills">
        {order.issueIds.length ? (
          <StatePill state="attention">Needs you</StatePill>
        ) : null}
        {order.overdue ? <Badge tone="danger">Overdue</Badge> : null}
        <Badge>{statusLabels[order.status] ?? order.status}</Badge>
        <Badge>
          {paymentLabels[order.paymentStatus] ?? order.paymentStatus}
        </Badge>
        <Badge tone="info">{fulfillmentLabel(order)}</Badge>
        {order.differs ? <Badge tone="warning">Differs by source</Badge> : null}
      </div>
      <p className="order-meta">
        {order.placedAt ? (
          <span>
            Placed <WorkspaceDate value={order.placedAt} />
          </span>
        ) : null}
        {order.total ? <span>Total {formatMoney(order.total)}</span> : null}
        {order.dueAt ? (
          <span>
            Due <WorkspaceDate value={order.dueAt} />
          </span>
        ) : null}
        <span>
          Read <WorkspaceDate value={order.observedAt} />
        </span>
      </p>
    </header>
  );
}
