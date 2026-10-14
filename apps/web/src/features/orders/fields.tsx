import type { OrderListItem } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import { ordersPresentation } from './collection';

/**
 * What needs attention about an order: needs you, overdue, a pending or inconclusive comparison
 * and differing sources. Every layout shows these, whatever the Display settings.
 */
export function OrderFlags({ order }: { order: OrderListItem }) {
  const flags = [
    order.issueIds.length ? (
      <StatePill key="needs-you" state="attention">
        {m.orders_flag_needs_you()}
      </StatePill>
    ) : null,
    order.overdue ? (
      <Badge key="overdue" tone="danger">
        {m.orders_flag_overdue()}
      </Badge>
    ) : null,
    order.comparisonState === 'pending' ? (
      <Badge key="comparison">{m.orders_comparison_pending()}</Badge>
    ) : order.comparisonState === 'inconclusive' ? (
      <Badge key="comparison">{m.orders_comparison_inconclusive()}</Badge>
    ) : null,
    order.differs ? (
      <Badge key="differs" tone="warning">
        {m.orders_flag_differs()}
      </Badge>
    ) : null,
    order.test ? <Badge key="test">{m.orders_charges_test()}</Badge> : null,
  ].filter(Boolean);

  return flags.length ? (
    <span className="orders-row-flags">{flags}</span>
  ) : null;
}

const empty = () => m.common_empty_value();

function date(value: string | null | undefined) {
  return value ? <WorkspaceDate value={value} /> : empty();
}

/** The sources that report an order, with removed and unhealthy connections marked. */
function OrderSources({ order }: { order: OrderListItem }) {
  return (
    <span className="orders-sources">
      {order.sources.map((source) => (
        <Badge
          key={source.connectionId}
          tone={
            source.deleted || source.connectionStatus !== 'active'
              ? 'warning'
              : 'neutral'
          }
          title={source.externalId ?? undefined}
        >
          {source.deleted
            ? m.orders_source_removed({ source: source.label })
            : source.label}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Renders one Orders catalog field of an order, for table cells, list and board properties and
 * the preview. Missing values show a dash; values a legacy read did not return show a dash too.
 */
export function orderField(order: OrderListItem, key: string): ReactNode {
  switch (key) {
    case 'number':
      return orderLabel(order);
    case 'placed':
      return date(order.placedAt);
    case 'updated':
      return date(order.sourceUpdatedAt ?? order.observedAt);
    case 'due':
      return date(order.dueAt);
    case 'status':
      return statusLabels[order.status] ?? order.status;
    case 'paymentStatus':
      return paymentLabels[order.paymentStatus] ?? order.paymentStatus;
    case 'fulfillment':
      return fulfillmentLabel(order);
    case 'total':
      return formatMoney(order.total) ?? empty();
    case 'lineCount':
      return formatNumber(order.lineCount);
    case 'sources':
      return <OrderSources order={order} />;
    case 'comparison':
      return (
        ordersPresentation.comparison?.option?.(order.comparisonState) ??
        order.comparisonState
      );
    case 'overdue':
      return order.overdue === null
        ? m.common_unknown()
        : order.overdue
          ? m.common_yes()
          : m.common_no();
    case 'channel':
      return order.channel ?? empty();
    case 'tags':
      return order.tags?.length ? (
        <span className="orders-sources">
          {order.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
      ) : (
        empty()
      );
    case 'test':
      return order.test === undefined || order.test === null
        ? empty()
        : order.test
          ? m.common_yes()
          : m.common_no();
    default:
      return null;
  }
}
