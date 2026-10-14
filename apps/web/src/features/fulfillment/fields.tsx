import type { FulfillmentItem, FulfillmentList } from '@luma/api-contract';
import { formatList, formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactNode } from 'react';

import {
  deliveryLabels,
  fulfillmentState,
  handoffLabels,
  holdText,
  kindLabels,
  methodLabels,
  orderLabel,
  otherSignals,
  quantity,
  signalLabels,
  statusLabels,
} from './presentation';

/** What the fields of one row need from the list: source names and the read time. */
export interface FulfillmentFieldContext {
  sources: FulfillmentList['sources'];
  asOf: string;
}

/**
 * Where the fulfillment stands, with signals the state doesn't already name. Every layout shows
 * these, whatever the Display settings.
 */
export function FulfillmentFlags({ item }: { item: FulfillmentItem }) {
  const state = fulfillmentState(item);

  return (
    <span className="fulfillment-flags">
      <StatePill state={state.state}>{state.label}</StatePill>
      {otherSignals(item).map((signal) => (
        <Badge key={signal} tone="warning">
          {signalLabels[signal]}
        </Badge>
      ))}
    </span>
  );
}

const empty = () => m.common_empty_value();

function date(value: string | null | undefined) {
  return value ? <WorkspaceDate value={value} /> : empty();
}

/** The name of the source that reports a fulfillment. */
export function sourceLabel(
  item: Pick<FulfillmentItem, 'connectionId'>,
  sources: FulfillmentList['sources'],
) {
  return (
    sources.find((source) => source.connectionId === item.connectionId)
      ?.label ?? m.fulfillment_source_fallback()
  );
}

/** The carriers a shipment's tracking names, without repeats. */
export function carriers(item: FulfillmentItem) {
  return [
    ...new Set(
      item.tracking.flatMap((entry) => (entry.carrier ? [entry.carrier] : [])),
    ),
  ];
}

/**
 * Renders one Fulfillment catalog field of a row, for table cells, list and board properties and
 * the preview. Facts the source does not report show "Not reported"; empty values show a dash.
 */
export function fulfillmentField(
  item: FulfillmentItem,
  key: string,
  context: FulfillmentFieldContext,
): ReactNode {
  switch (key) {
    case 'order':
      return orderLabel(item);
    case 'kind':
      return kindLabels[item.kind];
    case 'source':
      return sourceLabel(item, context.sources);
    case 'status':
      return statusLabels[item.status] ?? item.status;
    case 'signals':
      return item.signals.length
        ? formatList(item.signals.map((signal) => signalLabels[signal]))
        : empty();
    case 'holds':
      return item.holds === null
        ? m.common_not_reported()
        : item.holds.length
          ? holdText(item.holds)
          : empty();
    case 'location':
      return item.location?.name ?? m.common_not_reported();
    case 'method':
      return item.method
        ? (item.method.name ??
            methodLabels[item.method.type] ??
            m.fulfillment_method_unknown())
        : m.common_not_reported();
    case 'carrier': {
      const names = carriers(item);

      return names.length ? formatList(names) : empty();
    }
    case 'stage':
      return item.shipping ? handoffLabels[item.shipping.stage] : empty();
    case 'delivery':
      return item.delivery
        ? (deliveryLabels[item.delivery] ?? item.delivery)
        : empty();
    case 'fulfillAt':
      return date(item.fulfillAt);
    case 'fulfillBy':
      return date(item.fulfillBy);
    case 'estimatedDelivery':
      return date(item.estimatedDeliveryAt);
    case 'progress':
      return (
        item.lastProgressAt
          ? m.fulfillment_progress_last
          : m.fulfillment_progress_updated
      )({
        time: formatRelativeTime(item.progressAt, Date.parse(context.asOf)),
      });
    case 'orderPlaced':
      return date(item.order.placedAt);
    case 'units':
      return quantity(item.units, item.unit);
    case 'updated':
      return date(item.sourceUpdatedAt ?? item.observedAt);
    default:
      return null;
  }
}
