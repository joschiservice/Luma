import type {
  CollectionCondition,
  CollectionGranularity,
  CollectionGroup,
  CollectionWhere,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import {
  fulfillmentLabels,
  paymentLabels,
  statusLabels,
  viewLabels,
} from '../../shared/orders/presentation';

const order = () => m.orders_area_order();
const fulfillment = () => m.orders_area_fulfillment();
const sources = () => m.orders_area_sources();

const comparisonLabels: Record<string, () => string> = {
  matching: m.orders_comparison_matching,
  pending: m.orders_comparison_pending,
  confirmed: m.orders_comparison_confirmed,
  inconclusive: m.orders_comparison_inconclusive,
};

const cancelReasonLabels: Record<string, () => string> = {
  customer: m.orders_cancel_reason_customer,
  declined: m.orders_cancel_reason_declined,
  fraud: m.orders_cancel_reason_fraud,
  inventory: m.orders_cancel_reason_inventory,
  staff: m.orders_cancel_reason_staff,
  other: m.orders_cancel_reason_other,
  unknown: m.orders_cancel_reason_unknown,
};

/** How the Orders list names each catalog field and its options. */
export const ordersPresentation: CatalogPresentation = {
  number: { label: m.orders_column_order, group: order },
  placed: { label: m.orders_column_placed, group: order },
  updated: { label: m.orders_column_updated, group: order },
  due: { label: m.orders_field_due, group: order },
  status: {
    label: m.orders_column_status,
    group: order,
    option: (value) => statusLabels[value] ?? value,
  },
  paymentStatus: {
    label: m.orders_field_payment,
    group: order,
    option: (value) => paymentLabels[value] ?? value,
  },
  total: { label: m.orders_column_total, group: order },
  currency: { label: m.orders_field_currency, group: order },
  lineCount: { label: m.orders_field_line_count, group: order },
  channel: { label: m.orders_charges_channel, group: order },
  tags: { label: m.orders_charges_tags, group: order },
  discountCode: { label: m.orders_discount_kind_code, group: order },
  test: { label: m.orders_charges_test, group: order },
  cancelReason: {
    label: m.orders_charges_cancel_reason,
    group: order,
    option: (value) => cancelReasonLabels[value]?.() ?? value,
  },
  fulfillment: {
    label: m.orders_column_fulfillment,
    group: fulfillment,
    option: (value) => fulfillmentLabels[value] ?? value,
  },
  shippingMethod: { label: m.orders_field_shipping_method, group: fulfillment },
  country: {
    label: m.orders_field_country,
    description: m.orders_field_country_description,
    group: fulfillment,
  },
  warehouse: {
    label: m.orders_field_warehouse,
    description: m.orders_field_warehouse_description,
    group: fulfillment,
  },
  stockBlocked: {
    label: m.orders_field_stock_blocked,
    description: m.orders_field_stock_blocked_description,
    group: fulfillment,
  },
  overdue: { label: m.orders_field_overdue, group: fulfillment },
  source: { label: m.orders_filter_source, group: sources },
  sources: {
    label: m.orders_column_sources,
    description: m.orders_field_sources_description,
    group: sources,
  },
  comparison: {
    label: m.orders_field_comparison,
    description: m.orders_field_comparison_description,
    group: sources,
    option: (value) => comparisonLabels[value]?.() ?? value,
  },
  needsYou: { label: m.orders_field_needs_you, group: order },
  hasIssue: { label: m.orders_field_has_issue, group: order },
  customer: { label: m.orders_field_customer, group: order },
};

/** Names a built-in Orders view. */
export function orderSegmentLabel(segment: string) {
  const labels: Readonly<Record<string, string>> = viewLabels;

  return labels[segment] ?? segment;
}

/** Fields whose group keys are IDs named by options loaded at run time. */
const runtimeGroups: Readonly<Record<string, keyof RuntimeOptions>> = {
  source: 'connections',
  warehouse: 'locations',
};

/**
 * Names one group of the Orders list: an option's label, a source or warehouse name, a
 * calendar period in the workspace time zone (the server returns the period's first day), or
 * "No value" for orders without one.
 */
export function orderGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  if (key === null) return m.collections_group_none();
  const presentation = ordersPresentation[field];
  const fieldLabel = presentation?.label() ?? field;
  if (typeof key === 'boolean')
    return m.collections_group_boolean({
      field: fieldLabel,
      value: key ? m.common_yes() : m.common_no(),
    });
  const text = String(key);
  const runtime = runtimeGroups[field];
  if (runtime)
    return (
      options[runtime]?.find((option) => option.value === text)?.label ?? text
    );
  const day = /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
  if (granularity && day)
    return granularity === 'day'
      ? formatCalendarDate(day)
      : granularity === 'week'
        ? m.collections_group_week({ date: formatCalendarDate(day) })
        : formatCalendarDate(day, { month: 'long', year: 'numeric' });

  return presentation?.option?.(text) ?? text;
}

/** URL keys of Orders links from before configurable views, such as Insights drill-downs. */
export interface LegacyOrderSearch {
  status?: string | undefined;
  paymentStatus?: string | undefined;
  connectionId?: string | undefined;
  placedFrom?: string | undefined;
  placedTo?: string | undefined;
  updatedFrom?: string | undefined;
  updatedBefore?: string | undefined;
}

/**
 * Converts the filters older links use into conditions that select the same orders. Placed
 * bounds are inclusive workspace calendar days, which `between` resolves in the request's time
 * zone. Updated bounds are exact instants from metric drill-downs: the start is inclusive
 * (`between` with an open end) and `updatedBefore` stays exclusive (`before`).
 */
export function legacyOrderConditions(
  search: LegacyOrderSearch,
): CollectionCondition[] {
  const conditions: CollectionCondition[] = [];
  if (search.status)
    conditions.push({ field: 'status', op: 'any_of', value: [search.status] });
  if (search.paymentStatus)
    conditions.push({
      field: 'paymentStatus',
      op: 'any_of',
      value: [search.paymentStatus],
    });
  if (search.connectionId)
    conditions.push({
      field: 'source',
      op: 'any_of',
      value: [search.connectionId],
    });
  if (search.placedFrom || search.placedTo)
    conditions.push({
      field: 'placed',
      op: 'between',
      value: { from: search.placedFrom ?? null, to: search.placedTo ?? null },
    });
  if (search.updatedFrom)
    conditions.push({
      field: 'updated',
      op: 'between',
      value: { from: search.updatedFrom, to: null },
    });
  if (search.updatedBefore)
    conditions.push({
      field: 'updated',
      op: 'before',
      value: search.updatedBefore,
    });

  return conditions;
}

/**
 * Adds converted legacy conditions to the URL's conditions. They must all hold, so conditions
 * that match "any" are replaced only when they can't be combined: one condition matches the
 * same under either rule.
 */
export function withLegacyConditions(
  where: CollectionWhere | undefined,
  legacy: readonly CollectionCondition[],
): CollectionWhere {
  const current = where?.conditions ?? [];
  const kept = where?.match === 'any' && current.length > 1 ? [] : current;

  return { match: 'all', conditions: [...kept, ...legacy].slice(0, 20) };
}
