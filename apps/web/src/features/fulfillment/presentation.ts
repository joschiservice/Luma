import type {
  FulfillmentDetail,
  FulfillmentItem,
  FulfillmentSignal,
  FulfillmentView,
} from '@luma/api-contract';
import {
  formatList,
  formatNumber,
  formatRelativeTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import { quantityUnit, quantityWithUnit } from '@luma/ui/lib/units';

/** Reads each message when accessed, so labels follow the active language. */
function localized<K extends string>(
  messages: Record<K, () => string>,
): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const key of Object.keys(messages) as K[])
    Object.defineProperty(labels, key, {
      enumerable: true,
      get: () => messages[key](),
    });

  return labels;
}

export const viewLabels = localized({
  attention: m.fulfillment_view_attention,
  held: m.fulfillment_view_held,
  delayed: m.fulfillment_view_delayed,
  open: m.fulfillment_view_open,
  in_transit: m.fulfillment_view_in_transit,
  all: m.fulfillment_view_all,
} satisfies Record<FulfillmentView, () => string>);

export const viewDescriptions = localized({
  attention: m.fulfillment_view_attention_description,
  held: m.fulfillment_view_held_description,
  delayed: m.fulfillment_view_delayed_description,
  open: m.fulfillment_view_open_description,
  in_transit: m.fulfillment_view_in_transit_description,
  all: m.fulfillment_view_all_description,
} satisfies Record<FulfillmentView, () => string>);

export const signalLabels = localized({
  held: m.fulfillment_signal_held,
  overdue: m.fulfillment_signal_overdue,
  stalled: m.fulfillment_signal_stalled,
  delivery_issue: m.fulfillment_signal_delivery_issue,
  late_delivery: m.fulfillment_signal_late_delivery,
  failed: m.fulfillment_signal_failed,
} satisfies Record<FulfillmentSignal, () => string>);

const holdLabels: Record<string, string> = localized({
  awaiting_payment: m.fulfillment_hold_awaiting_payment,
  high_risk_of_fraud: m.fulfillment_hold_high_risk_of_fraud,
  incorrect_address: m.fulfillment_hold_incorrect_address,
  inventory_out_of_stock: m.fulfillment_hold_inventory_out_of_stock,
  unknown_delivery_date: m.fulfillment_hold_unknown_delivery_date,
  awaiting_return_items: m.fulfillment_hold_awaiting_return_items,
  other: m.fulfillment_hold_other,
});

export const statusLabels: Record<string, string> = localized({
  pending: m.fulfillment_status_pending,
  processing: m.fulfillment_status_processing,
  completed: m.fulfillment_status_completed,
  shipped: m.fulfillment_status_shipped,
  delivered: m.fulfillment_status_delivered,
  cancelled: m.fulfillment_status_cancelled,
  failed: m.fulfillment_status_failed,
  unknown: m.fulfillment_status_unknown,
});

export const deliveryLabels: Record<string, string> = localized({
  label_created: m.fulfillment_delivery_label_created,
  in_transit: m.fulfillment_delivery_in_transit,
  out_for_delivery: m.fulfillment_delivery_out_for_delivery,
  attempted_delivery: m.fulfillment_delivery_attempted_delivery,
  delayed: m.fulfillment_delivery_delayed,
  ready_for_pickup: m.fulfillment_delivery_ready_for_pickup,
  delivered: m.fulfillment_delivery_delivered,
  failed: m.fulfillment_delivery_failed,
});

export const kindLabels = localized({
  fulfillment_order: m.fulfillment_kind_fulfillment_order,
  shipment: m.fulfillment_kind_shipment,
  unknown: m.fulfillment_kind_unknown,
} satisfies Record<FulfillmentItem['kind'], () => string>);

export const methodLabels: Record<string, string> = localized({
  shipping: m.fulfillment_method_shipping,
  pick_up: m.fulfillment_method_pick_up,
  pickup_point: m.fulfillment_method_pickup_point,
  local: m.fulfillment_method_local,
  retail: m.fulfillment_method_retail,
  none: m.fulfillment_method_none,
  unknown: m.fulfillment_method_unknown,
});

export const sortLabels = localized({
  waiting: m.fulfillment_sort_waiting,
  recent: m.fulfillment_sort_recent,
  deadline: m.fulfillment_sort_deadline,
});

/** Describes a length of time in whole units, such as "3 days" or "20 hours". */
export function duration(milliseconds: number) {
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  if (minutes >= 2880)
    return m.fulfillment_duration_days({ count: Math.floor(minutes / 1440) });
  if (minutes >= 120)
    return m.fulfillment_duration_hours({ count: Math.floor(minutes / 60) });

  return m.fulfillment_duration_minutes({ count: minutes });
}

/** Describes a quantity with the source's unit name, or as units when none is reported. */
export function quantity(units: string, unit: string | null) {
  const count = Number(units);
  if (!Number.isFinite(count))
    return unit ? quantityWithUnit(units, unit, units) : units;

  return unit
    ? m.fulfillment_units_named({
        count: formatNumber(count),
        unit: quantityUnit(unit, count),
      })
    : m.fulfillment_units({ count });
}

/** Names a fulfillment by its order number, falling back to a short order ID. */
export function orderLabel(item: Pick<FulfillmentItem, 'order'>) {
  return (
    item.order.number ??
    m.fulfillment_order_fallback({ id: item.order.id.slice(0, 8) })
  );
}

/** Lists hold reasons as readable text. */
export function holdText(holds: string[] | null) {
  return formatList((holds ?? []).map((hold) => holdLabels[hold] ?? hold));
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
  if (item.deleted)
    return { state: 'idle', label: m.fulfillment_state_removed() };
  if (has('failed'))
    return {
      state: 'error',
      label: m.fulfillment_state_failed(),
      signal: 'failed',
    };
  if (has('held'))
    return {
      state: 'attention',
      label: m.fulfillment_state_held(),
      signal: 'held',
    };
  if (has('delivery_issue'))
    return {
      state: 'attention',
      label:
        deliveryLabels[item.delivery ?? ''] ??
        m.fulfillment_state_delivery_problem(),
      signal: 'delivery_issue',
    };
  if (has('overdue'))
    return {
      state: 'attention',
      label: m.fulfillment_state_overdue(),
      signal: 'overdue',
    };
  if (has('late_delivery'))
    return {
      state: 'attention',
      label: m.fulfillment_state_late_delivery(),
      signal: 'late_delivery',
    };
  if (has('stalled'))
    return {
      state: 'waiting',
      label: m.fulfillment_state_stalled(),
      signal: 'stalled',
    };
  switch (item.status) {
    case 'delivered':
      return { state: 'verified', label: m.fulfillment_state_delivered() };
    case 'completed':
      return { state: 'verified', label: m.fulfillment_state_completed() };
    case 'shipped':
      return {
        state: 'running',
        label:
          deliveryLabels[item.delivery ?? ''] ?? m.fulfillment_state_shipped(),
      };
    case 'processing':
      return { state: 'running', label: m.fulfillment_state_in_progress() };
    case 'pending':
      return item.open
        ? { state: 'waiting', label: m.fulfillment_state_waiting() }
        : { state: 'idle', label: m.fulfillment_state_not_expected() };
    case 'cancelled':
      return { state: 'idle', label: m.fulfillment_state_cancelled() };
    default:
      return {
        state: 'idle',
        label: statusLabels[item.status] ?? m.common_unknown(),
      };
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
  if (item.deleted) return m.fulfillment_reason_removed();
  if (has('failed'))
    return item.failureCode
      ? m.fulfillment_reason_failed_code({ code: item.failureCode })
      : m.fulfillment_reason_failed();
  if (has('held'))
    return m.fulfillment_reason_held({ holds: holdText(item.holds) });
  if (has('delivery_issue')) {
    const status =
      deliveryLabels[item.delivery ?? ''] ??
      m.fulfillment_state_delivery_problem();

    return tracking?.number
      ? m.fulfillment_reason_delivery_tracking({
          status,
          tracking: tracking.number,
        })
      : m.fulfillment_reason_delivery({ status });
  }
  if (has('overdue') && item.fulfillBy)
    return m.fulfillment_reason_overdue({
      time: formatRelativeTime(item.fulfillBy, now),
    });
  if (has('late_delivery') && item.estimatedDeliveryAt)
    return m.fulfillment_reason_late({
      time: formatRelativeTime(item.estimatedDeliveryAt, now),
    });
  if (has('stalled'))
    return m.fulfillment_reason_stalled({
      duration: duration(now - Date.parse(item.progressAt)),
    });
  if (item.status === 'shipped')
    return tracking
      ? [tracking.carrier, tracking.number].filter(Boolean).join(' ')
      : m.fulfillment_reason_no_tracking();
  if (item.open && item.fulfillAt && Date.parse(item.fulfillAt) > now)
    return m.fulfillment_reason_scheduled({
      time: formatRelativeTime(item.fulfillAt, now),
    });
  if (item.open && item.fulfillBy)
    return m.fulfillment_reason_due({
      time: formatRelativeTime(item.fulfillBy, now),
    });
  if (item.open)
    return m.fulfillment_reason_last_progress({
      time: formatRelativeTime(item.progressAt, now),
    });

  return statusLabels[item.status] ?? m.fulfillment_status_unknown();
}

export type NextStep = {
  title: string;
  body: string;
  /** Source actions the host can offer in place. */
  action: 'release' | 'carrier' | 'none';
};

const holdAdvice: Record<string, () => string> = {
  awaiting_payment: m.fulfillment_advice_awaiting_payment,
  high_risk_of_fraud: m.fulfillment_advice_high_risk_of_fraud,
  incorrect_address: m.fulfillment_advice_incorrect_address,
  inventory_out_of_stock: m.fulfillment_advice_inventory_out_of_stock,
  unknown_delivery_date: m.fulfillment_advice_unknown_delivery_date,
  awaiting_return_items: m.fulfillment_advice_awaiting_return_items,
  other: m.fulfillment_advice_other,
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
  const location = item.location?.name;
  if (has('held')) {
    const advice = [
      ...new Set(
        (item.holds ?? []).map((hold) =>
          (holdAdvice[hold] ?? m.fulfillment_advice_other)(),
        ),
      ),
    ].join(' ');

    return canRelease
      ? {
          title: m.fulfillment_next_release_title(),
          body: m.fulfillment_next_release_body({
            advice,
            source: source.label,
          }),
          action: 'release',
        }
      : {
          title: m.fulfillment_next_hold_title({ source: source.label }),
          body: m.fulfillment_next_hold_body({ advice }),
          action: 'none',
        };
  }
  if (has('failed'))
    return {
      title: m.fulfillment_next_failed_title({ source: source.label }),
      body: m.fulfillment_next_failed_body(),
      action: 'none',
    };
  if (has('delivery_issue') || has('late_delivery'))
    return {
      title: tracking?.carrier
        ? m.fulfillment_next_carrier_title({ carrier: tracking.carrier })
        : m.fulfillment_next_carrier_unknown_title(),
      body: tracking?.number
        ? m.fulfillment_next_carrier_body({ tracking: tracking.number })
        : m.fulfillment_next_carrier_no_tracking_body(),
      action: tracking?.url ? 'carrier' : 'none',
    };
  if (has('overdue') || has('stalled'))
    return {
      title: location
        ? m.fulfillment_next_location_title({ location })
        : m.fulfillment_next_location_unknown_title(),
      body: m.fulfillment_next_location_body(),
      action: 'none',
    };
  if (item.open)
    return {
      title: m.fulfillment_next_none_title(),
      body: m.fulfillment_next_open_body({ hours: detail.stalledAfterHours }),
      action: 'none',
    };
  if (item.status === 'shipped')
    return {
      title: m.fulfillment_next_none_title(),
      body: m.fulfillment_next_shipped_body(),
      action: tracking?.url ? 'carrier' : 'none',
    };

  return {
    title: m.fulfillment_next_finished_title(),
    body: m.fulfillment_next_finished_body(),
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
        ? [m.fulfillment_change_earliest()]
        : [
            m.fulfillment_change_first_read({
              status: statusLabels[entry.status] ?? entry.status,
            }),
          ];
    const changes: string[] = [];
    if (entry.deleted && !before.deleted)
      changes.push(m.fulfillment_change_removed());
    if (entry.status !== before.status)
      changes.push(
        m.fulfillment_change_status({
          from: statusLabels[before.status] ?? before.status,
          to: statusLabels[entry.status] ?? entry.status,
        }),
      );
    if (set(entry.holds) !== set(before.holds)) {
      const added = (entry.holds ?? []).filter(
        (hold) => !(before.holds ?? []).includes(hold),
      );
      if (added.length)
        changes.push(
          m.fulfillment_change_hold_added({ holds: holdText(added) }),
        );
      else if (!(entry.holds ?? []).length)
        changes.push(m.fulfillment_change_holds_released());
      else
        changes.push(
          m.fulfillment_change_holds_now({ holds: holdText(entry.holds) }),
        );
    }
    if (entry.delivery !== before.delivery && entry.delivery)
      changes.push(
        m.fulfillment_change_carrier({
          status: deliveryLabels[entry.delivery] ?? entry.delivery,
        }),
      );
    if (entry.locationName !== before.locationName && entry.locationName)
      changes.push(
        m.fulfillment_change_location({ location: entry.locationName }),
      );
    if (entry.fulfillBy !== before.fulfillBy)
      changes.push(
        entry.fulfillBy
          ? m.fulfillment_change_deadline_changed()
          : m.fulfillment_change_deadline_removed(),
      );
    if (
      !changes.length &&
      entry.lastProgressAt &&
      entry.lastProgressAt !== before.lastProgressAt
    )
      changes.push(m.fulfillment_change_progress());

    return changes;
  });
}

type TimelineGroup = {
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
  const relative = (value: string) => formatRelativeTime(value, now);
  const deadline =
    item.open && item.fulfillBy
      ? has('overdue')
        ? m.fulfillment_diagnosis_was_due({ time: relative(item.fulfillBy) })
        : m.fulfillment_diagnosis_is_due({ time: relative(item.fulfillBy) })
      : null;
  const progress = m.fulfillment_diagnosis_last_progress({
    time: relative(item.progressAt),
  });
  // Each part is a complete sentence, so joining them keeps each one translatable.
  const sentences = (...parts: (string | null)[]) =>
    parts.filter(Boolean).join(' ');
  if (item.deleted)
    return {
      title: m.fulfillment_diagnosis_removed_title(),
      body: m.fulfillment_diagnosis_removed_body(),
    };
  if (has('failed'))
    return {
      title: m.fulfillment_diagnosis_failed_title(),
      body: sentences(fulfillmentReason(item, asOf), progress),
    };
  if (has('held'))
    return {
      title: m.fulfillment_diagnosis_held_title({
        holds: holdText(item.holds),
      }),
      body: sentences(m.fulfillment_diagnosis_held_body(), deadline),
    };
  if (has('delivery_issue')) {
    const expected = item.estimatedDeliveryAt;

    return {
      title:
        deliveryLabels[item.delivery ?? ''] ??
        m.fulfillment_state_delivery_problem(),
      body: sentences(
        m.fulfillment_diagnosis_delivery_body(),
        expected
          ? Date.parse(expected) < now
            ? m.fulfillment_diagnosis_delivery_was_expected({
                time: relative(expected),
              })
            : m.fulfillment_diagnosis_delivery_is_expected({
                time: relative(expected),
              })
          : null,
      ),
    };
  }
  if (has('overdue'))
    return {
      title: m.fulfillment_diagnosis_overdue_title(),
      body: sentences(
        m.fulfillment_diagnosis_overdue_body(),
        deadline,
        progress,
      ),
    };
  if (has('late_delivery') && item.estimatedDeliveryAt)
    return {
      title: m.fulfillment_diagnosis_late_title(),
      body: m.fulfillment_diagnosis_late_body({
        time: relative(item.estimatedDeliveryAt),
      }),
    };
  if (has('stalled'))
    return {
      title: m.fulfillment_diagnosis_stalled_title({
        duration: duration(now - Date.parse(item.progressAt)),
      }),
      body: sentences(m.fulfillment_diagnosis_stalled_body(), deadline),
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
