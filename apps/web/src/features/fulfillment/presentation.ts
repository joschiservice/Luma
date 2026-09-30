import type {
  FulfillmentDetail,
  FulfillmentItem,
  FulfillmentSignal,
  FulfillmentView,
} from '@luma/api-contract';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { ago, soon } from '../sync/presentation';

export const viewLabels: Record<FulfillmentView, string> = {
  attention: 'Needs attention',
  held: 'On hold',
  delayed: 'Delayed',
  open: 'Open work',
  in_transit: 'In transit',
  all: 'All',
};

export const viewDescriptions: Record<FulfillmentView, string> = {
  attention: 'Held, delayed and failed fulfillments, longest wait first.',
  held: 'Open work stopped by a hold at the source.',
  delayed:
    'Open work past its fulfill-by date or without progress, and shipments with a delivery problem or past their estimate.',
  open: 'Fulfillment work the source still expects to complete.',
  in_transit: 'Shipments that left a location and are not delivered yet.',
  all: 'Every fulfillment order and shipment your sources report.',
};

export const signalLabels: Record<FulfillmentSignal, string> = {
  held: 'On hold',
  overdue: 'Past fulfill-by',
  stalled: 'No progress',
  delivery_issue: 'Delivery problem',
  late_delivery: 'Late delivery',
  failed: 'Failed',
};

export const holdLabels: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  high_risk_of_fraud: 'High fraud risk',
  incorrect_address: 'Incorrect address',
  inventory_out_of_stock: 'Out of stock',
  unknown_delivery_date: 'Unknown delivery date',
  awaiting_return_items: 'Awaiting returned items',
  other: 'Other reason',
};

export const statusLabels: Record<string, string> = {
  pending: 'Waiting to start',
  processing: 'In progress',
  completed: 'Completed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Failed',
  unknown: 'Status unknown',
};

export const deliveryLabels: Record<string, string> = {
  label_created: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  attempted_delivery: 'Delivery attempted',
  delayed: 'Carrier reports a delay',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  failed: 'Delivery failed',
};

export const kindLabels: Record<FulfillmentItem['kind'], string> = {
  fulfillment_order: 'Fulfillment order',
  shipment: 'Shipment',
  unknown: 'Fulfillment',
};

export const methodLabels: Record<string, string> = {
  shipping: 'Shipping',
  pick_up: 'Pickup',
  pickup_point: 'Pickup point',
  local: 'Local delivery',
  retail: 'In store',
  none: 'No delivery',
  unknown: 'Delivery',
};

export const sortLabels = {
  waiting: 'Longest waiting',
  recent: 'Recent progress',
  deadline: 'Deadline',
} as const;

/** Describes a length of time in whole units, such as "3 days" or "20 hours". */
export function duration(milliseconds: number) {
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  const [value, unit] =
    minutes >= 2880
      ? [Math.floor(minutes / 1440), 'day']
      : minutes >= 120
        ? [Math.floor(minutes / 60), 'hour']
        : [minutes, 'minute'];

  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** Names a fulfillment by its order number, falling back to a short order ID. */
export function orderLabel(item: Pick<FulfillmentItem, 'order'>) {
  return item.order.number ?? `Order ${item.order.id.slice(0, 8)}`;
}

/** Lists hold reasons as readable text. */
export function holdText(holds: string[] | null) {
  return (holds ?? []).map((hold) => holdLabels[hold] ?? hold).join(', ');
}

/**
 * The one state that best describes where a fulfillment stands, with a text label and the
 * attention signal it represents, if any.
 */
export function fulfillmentState(item: FulfillmentItem): {
  state: OperationalState;
  label: string;
  signal?: FulfillmentSignal;
} {
  const has = (signal: FulfillmentSignal) => item.signals.includes(signal);
  if (item.deleted) return { state: 'idle', label: 'Removed at source' };
  if (has('failed'))
    return { state: 'error', label: 'Failed', signal: 'failed' };
  if (has('held'))
    return { state: 'attention', label: 'On hold', signal: 'held' };
  if (has('delivery_issue'))
    return {
      state: 'attention',
      label: deliveryLabels[item.delivery ?? ''] ?? 'Delivery problem',
      signal: 'delivery_issue',
    };
  if (has('overdue'))
    return { state: 'attention', label: 'Past fulfill-by', signal: 'overdue' };
  if (has('late_delivery'))
    return {
      state: 'attention',
      label: 'Late delivery',
      signal: 'late_delivery',
    };
  if (has('stalled'))
    return { state: 'waiting', label: 'No recent progress', signal: 'stalled' };
  switch (item.status) {
    case 'delivered':
      return { state: 'verified', label: 'Delivered' };
    case 'completed':
      return { state: 'verified', label: 'Completed' };
    case 'shipped':
      return {
        state: 'running',
        label: deliveryLabels[item.delivery ?? ''] ?? 'Shipped',
      };
    case 'processing':
      return { state: 'running', label: 'In progress' };
    case 'pending':
      return item.open
        ? { state: 'waiting', label: 'Waiting to start' }
        : { state: 'idle', label: 'Not expected' };
    case 'cancelled':
      return { state: 'idle', label: 'Cancelled' };
    default:
      return { state: 'idle', label: statusLabels[item.status] ?? 'Unknown' };
  }
}

/** Signals beyond the one the state already names, for secondary badges. */
export function otherSignals(item: FulfillmentItem) {
  const { signal } = fulfillmentState(item);

  return item.signals.filter((entry) => entry !== signal);
}

/** A one-line explanation of what blocks or describes the fulfillment right now. */
export function fulfillmentReason(item: FulfillmentItem, asOf: string) {
  const now = Date.parse(asOf);
  const has = (signal: FulfillmentSignal) => item.signals.includes(signal);
  const tracking = item.tracking.find((entry) => entry.number);
  if (item.deleted) return 'The source no longer reports this fulfillment.';
  if (has('failed'))
    return `The source reports a failure${item.failureCode ? ` (${item.failureCode})` : ''}.`;
  if (has('held')) return `Held: ${holdText(item.holds)}.`;
  if (has('delivery_issue'))
    return `${deliveryLabels[item.delivery ?? ''] ?? 'Delivery problem'}${tracking?.number ? ` · ${tracking.number}` : ''}.`;
  if (has('overdue') && item.fulfillBy)
    return `Fulfill-by date passed ${ago(item.fulfillBy, now)}.`;
  if (has('late_delivery') && item.estimatedDeliveryAt)
    return `Expected ${ago(item.estimatedDeliveryAt, now)}, not delivered.`;
  if (has('stalled'))
    return `No progress for ${duration(now - Date.parse(item.progressAt))}.`;
  if (item.status === 'shipped')
    return tracking
      ? `${tracking.carrier ? `${tracking.carrier} ` : ''}${tracking.number}`
      : 'No tracking reported.';
  if (item.open && item.fulfillAt && Date.parse(item.fulfillAt) > now)
    return `Scheduled to start ${soon(item.fulfillAt, now)}.`;
  if (item.open && item.fulfillBy)
    return `Fulfill by ${soon(item.fulfillBy, now).replace(/^in /, 'within ')}.`;
  if (item.open) return `Last progress ${ago(item.progressAt, now)}.`;

  return statusLabels[item.status] ?? 'Status unknown';
}

export type NextStep = {
  title: string;
  body: string;
  /** Source actions the host can offer in place. */
  action: 'release' | 'carrier' | 'none';
};

const holdAdvice: Record<string, string> = {
  awaiting_payment:
    'Confirm the payment was captured before releasing the hold.',
  high_risk_of_fraud:
    'Review the order’s fraud analysis before releasing. Cancel instead if the order is not genuine.',
  incorrect_address:
    'Confirm the shipping address with the customer and correct it at the source.',
  inventory_out_of_stock:
    'Restock the items, or move the work to a location that has them.',
  unknown_delivery_date:
    'Agree a delivery date with the customer before releasing.',
  awaiting_return_items:
    'Wait for the returned items to arrive, or release if they are not needed.',
  other: 'Check why the work was held at the source.',
};

/**
 * The next safe step for the fulfillment and whether the host can offer a source action. A
 * release is offered only for held work at a source whose app supports it.
 */
export function nextStep(
  detail: Pick<FulfillmentDetail, 'item' | 'source' | 'stalledAfterHours'>,
  canRelease: boolean,
): NextStep {
  const { item, source } = detail;
  const has = (signal: FulfillmentSignal) => item.signals.includes(signal);
  const tracking = item.tracking.find((entry) => entry.number || entry.url);
  const where = item.location?.name ?? 'the fulfilling location';
  if (has('held')) {
    const advice = [
      ...new Set(
        (item.holds ?? []).map((hold) => holdAdvice[hold] ?? holdAdvice.other!),
      ),
    ];

    return canRelease
      ? {
          title: 'Resolve the hold reason, then release the hold',
          body: `${advice.join(' ')} Releasing asks ${source.label} to resume the work. Luma counts the fulfillment as restored only when a fresh read shows fewer units remaining.`,
          action: 'release',
        }
      : {
          title: `Resolve the hold in ${source.label}`,
          body: `${advice.join(' ')} Luma cannot release holds for this source. It shows the change on the next read.`,
          action: 'none',
        };
  }
  if (has('failed'))
    return {
      title: `Inspect the failure in ${source.label}`,
      body: 'Find out why the fulfillment failed, then retry it or create a new one at the source. Luma shows the new state on the next read.',
      action: 'none',
    };
  if (has('delivery_issue') || has('late_delivery'))
    return {
      title: tracking?.carrier
        ? `Check the shipment with ${tracking.carrier}`
        : 'Check the shipment with the carrier',
      body: `${tracking?.number ? `Use tracking number ${tracking.number}. ` : 'No tracking number is reported, so ask the fulfilling location which carrier took it. '}Arrange redelivery or collection with the customer if needed. Delivery shows here once the source reports it.`,
      action: tracking?.url ? 'carrier' : 'none',
    };
  if (has('overdue') || has('stalled'))
    return {
      title: `Ask ${where} what holds up the work`,
      body: 'Check whether the items were picked and packed. If the order is stuck on the wrong shipping method, correcting the method changes how it ships but does not prove that it shipped. Luma looks for a shipment or completed work in later reads.',
      action: 'none',
    };
  if (item.open)
    return {
      title: 'No action needed now',
      body: `Luma flags this work if it passes its fulfill-by date or reports no progress for ${detail.stalledAfterHours} hours.`,
      action: 'none',
    };
  if (item.status === 'shipped')
    return {
      title: 'No action needed now',
      body: 'The shipment is on its way. Luma flags a reported delivery problem or a missed estimate.',
      action: tracking?.url ? 'carrier' : 'none',
    };

  return {
    title: 'No further work expected',
    body: 'The source reports this fulfillment as finished or no longer expected.',
    action: 'none',
  };
}

type TimelineEntry = FulfillmentDetail['timeline']['entries'][number];

const set = (values: string[] | null) => [...(values ?? [])].sort().join(',');

/**
 * Describes what changed in each observed state compared with the previous (older) read.
 * The oldest shown entry is described as the first read.
 */
export function timelineChanges(entries: TimelineEntry[], truncated = false) {
  return entries.map((entry, index) => {
    const before = entries[index + 1];
    if (!before)
      return truncated
        ? ['Earliest shown read']
        : [`First read: ${statusLabels[entry.status] ?? entry.status}`];
    const changes: string[] = [];
    if (entry.deleted && !before.deleted) changes.push('Removed at source');
    if (entry.status !== before.status)
      changes.push(
        `${statusLabels[before.status] ?? before.status} → ${statusLabels[entry.status] ?? entry.status}`,
      );
    if (set(entry.holds) !== set(before.holds)) {
      const added = (entry.holds ?? []).filter(
        (hold) => !(before.holds ?? []).includes(hold),
      );
      if (added.length) changes.push(`Hold added: ${holdText(added)}`);
      else if (!(entry.holds ?? []).length) changes.push('Holds released');
      else changes.push(`Holds now: ${holdText(entry.holds)}`);
    }
    if (entry.delivery !== before.delivery && entry.delivery)
      changes.push(
        `Carrier: ${deliveryLabels[entry.delivery] ?? entry.delivery}`,
      );
    if (entry.locationName !== before.locationName && entry.locationName)
      changes.push(`Location: ${entry.locationName}`);
    if (entry.fulfillBy !== before.fulfillBy)
      changes.push(
        entry.fulfillBy ? 'Fulfill-by date changed' : 'Fulfill-by date removed',
      );
    if (
      !changes.length &&
      entry.lastProgressAt &&
      entry.lastProgressAt !== before.lastProgressAt
    )
      changes.push('Source reported progress');

    return changes;
  });
}

export type TimelineGroup = {
  entry: TimelineEntry;
  changes: string[];
  /** Consecutive reads without a visible change, oldest first; empty for a changed read. */
  repeats: TimelineEntry[];
};

/**
 * Groups the timeline for reading: each changed read stands alone, and consecutive reads
 * without a visible change collapse into one group.
 */
export function timelineGroups(entries: TimelineEntry[], truncated = false) {
  const changes = timelineChanges(entries, truncated);
  const groups: TimelineGroup[] = [];
  entries.forEach((entry, index) => {
    const changed = changes[index]!;
    const last = groups.at(-1);
    if (!changed.length && last && !last.changes.length)
      last.repeats.push(entry);
    else
      groups.push({
        entry,
        changes: changed,
        repeats: changed.length ? [] : [entry],
      });
  });

  return groups;
}

/** A headline and explanation of where the fulfillment stands, for the detail page. */
export function diagnosis(item: FulfillmentItem, asOf: string) {
  const now = Date.parse(asOf);
  const has = (signal: FulfillmentSignal) => item.signals.includes(signal);
  const deadline =
    item.open && item.fulfillBy
      ? has('overdue')
        ? ` It was due to be fulfilled ${ago(item.fulfillBy, now)}.`
        : ` It is due to be fulfilled ${soon(item.fulfillBy, now)}.`
      : '';
  const progress = ` The source last reported progress ${ago(item.progressAt, now)}.`;
  if (item.deleted)
    return {
      title: 'No longer reported',
      body: 'The source removed this fulfillment. Luma keeps its history as evidence.',
    };
  if (has('failed'))
    return {
      title: 'Fulfillment failed',
      body: `${fulfillmentReason(item, asOf)}${progress}`,
    };
  if (has('held'))
    return {
      title: `On hold: ${holdText(item.holds)}`,
      body: `The source stopped this work until the hold is released.${deadline}`,
    };
  if (has('delivery_issue'))
    return {
      title: deliveryLabels[item.delivery ?? ''] ?? 'Delivery problem',
      body: `The carrier reports a problem delivering this shipment.${item.estimatedDeliveryAt ? ` It was expected ${Date.parse(item.estimatedDeliveryAt) < now ? ago(item.estimatedDeliveryAt, now) : soon(item.estimatedDeliveryAt, now)}.` : ''}`,
    };
  if (has('overdue'))
    return {
      title: 'Past its fulfill-by date',
      body: `The work is still open.${deadline}${progress}`,
    };
  if (has('late_delivery') && item.estimatedDeliveryAt)
    return {
      title: 'Delivery is late',
      body: `The shipment was expected ${ago(item.estimatedDeliveryAt, now)} and the source has not reported it delivered.`,
    };
  if (has('stalled'))
    return {
      title: `No progress for ${duration(now - Date.parse(item.progressAt))}`,
      body: `The work is open, but the source has reported nothing new.${deadline}`,
    };

  return {
    title: fulfillmentState(item).label,
    body: fulfillmentReason(item, asOf),
  };
}

/** When the source last reported a change Luma could see, from the newest changed read. */
export function lastChange(detail: Pick<FulfillmentDetail, 'timeline'>) {
  const entries = detail.timeline.entries;
  const changes = timelineChanges(entries, detail.timeline.truncated);
  const index = changes.findIndex((list) => list.length > 0);
  const entry = entries[index];

  return entry
    ? {
        at: entry.sourceUpdatedAt ?? entry.observedAt,
        observedAt: entry.observedAt,
        changes: changes[index]!,
      }
    : null;
}
