import type {
  AdaptiveViewDomain,
  CollectionDomain,
  CustomField,
} from '@luma/api-contract';
import { formatCurrency, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { getLocale } from '@luma/i18n/runtime';

import type { CustomFieldColumn } from '../../kit/collections/fields';
import {
  fulfillmentLabels,
  paymentLabels,
  statusLabels,
} from '../../shared/orders/presentation';
import { previewable } from './query-fields';

/** Reads a workspace-authored bilingual label in the interface language. */
export function adaptiveLabel(label: { en: string; de: string }) {
  return label[getLocale()];
}

/** Names query domains without exposing internal owner identifiers. */
export function domainOptions() {
  return [
    { value: 'orders', label: m.adaptive_orders() },
    { value: 'inventory', label: m.adaptive_inventory() },
    { value: 'fulfillment', label: m.identity_nav_fulfillment() },
    { value: 'customers', label: m.identity_nav_customers() },
    { value: 'products', label: m.identity_nav_products() },
    { value: 'procurement', label: m.identity_nav_procurement() },
    { value: 'issues', label: m.identity_nav_issues() },
    { value: 'decisions', label: m.adaptive_decisions() },
  ] satisfies { value: AdaptiveViewDomain; label: string }[];
}

/** Names any list a saved view can describe, including lists the preview cannot read. */
export function domainLabel(domain: CollectionDomain) {
  const labels: Record<CollectionDomain, () => string> = {
    orders: m.adaptive_orders,
    inventory: m.adaptive_inventory,
    fulfillment: m.identity_nav_fulfillment,
    customers: m.identity_nav_customers,
    products: m.identity_nav_products,
    procurement: m.identity_nav_procurement,
    issues: m.identity_nav_issues,
    decisions: m.adaptive_decisions,
    transfers: m.adaptive_transfers,
    returns: m.identity_nav_returns,
    suppliers: m.adaptive_suppliers,
    inbox: m.identity_nav_inbox,
    activity: m.identity_nav_activity,
  };

  return labels[domain]();
}

const segmentMessages: Record<string, () => string> = {
  all: m.adaptive_segment_all,
  outstanding: m.adaptive_segment_outstanding,
  overdue: m.adaptive_segment_overdue,
  needs_you: m.adaptive_segment_needs_you,
  differs: m.adaptive_segment_differs,
  stuck: m.adaptive_segment_stuck,
  attention: m.adaptive_segment_attention,
  held: m.adaptive_segment_held,
  delayed: m.adaptive_segment_delayed,
  open: m.adaptive_segment_open,
  in_transit: m.adaptive_segment_in_transit,
  missing: m.adaptive_segment_missing,
  unlinked: m.adaptive_segment_unlinked,
  unknown: m.adaptive_segment_unknown,
  active: m.adaptive_segment_active,
  history: m.adaptive_segment_history,
  mine: m.adaptive_segment_mine,
  unassigned: m.adaptive_segment_unassigned,
};

/** Names a list's built-in view; unknown segments show their identifier readably. */
export function segmentLabel(segment: string) {
  return segmentMessages[segment]?.() ?? segment.replaceAll('_', ' ');
}

/** Renders only scalar record values; nested evidence is available in the record inspector. */
export function cellValue(value: unknown): string {
  if (value === null || value === undefined) return m.adaptive_unknown();
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean')
    return value ? m.adaptive_yes() : m.adaptive_no();
  if (typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    'amount' in value &&
    'currency' in value &&
    typeof value.amount === 'string' &&
    typeof value.currency === 'string'
  ) {
    const amount = Number(value.amount);
    if (Number.isFinite(amount)) {
      try {
        return formatCurrency(amount, value.currency);
      } catch {
        return `${value.amount} ${value.currency}`;
      }
    }
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.join(', ');

  return m.adaptive_unavailable_field();
}

/**
 * Names catalog field IDs, earlier item keys and editor identifiers. Labels are shared across
 * lists, so they stay general where lists use one ID for different things.
 */
const columnMessages: Record<string, () => string> = {
  number: m.adaptive_column_number,
  placed: m.adaptive_column_placed_at,
  due: m.adaptive_column_due_at,
  updated: m.adaptive_column_updated_at,
  created: m.adaptive_column_created_at,
  name: m.adaptive_column_display_name,
  orders: m.adaptive_column_order_count,
  order: m.adaptive_column_order_label,
  supplier: m.adaptive_column_supplier_name,
  lines: m.adaptive_column_line_count,
  confirmationDue: m.adaptive_column_confirmation_due_at,
  nextCheck: m.adaptive_column_next_check_at,
  detected: m.adaptive_column_detected_at,
  lastActivity: m.adaptive_column_last_activity_at,
  customer: m.adaptive_column_customer_id,
  source: m.adaptive_column_source,
  comparison: m.adaptive_column_comparison,
  warehouse: m.adaptive_column_warehouse,
  needsYou: m.adaptive_column_needs_you,
  hasIssue: m.adaptive_column_has_issue,
  phone: m.adaptive_column_phone,
  spent: m.adaptive_column_spent,
  tags: m.adaptive_column_tags,
  signals: m.adaptive_column_signals,
  holds: m.adaptive_column_holds,
  method: m.adaptive_column_method,
  carrier: m.adaptive_column_carrier,
  delivery: m.adaptive_column_delivery,
  fulfillAt: m.adaptive_column_fulfill_at,
  fulfillBy: m.adaptive_column_fulfill_by,
  estimatedDelivery: m.adaptive_column_estimated_delivery,
  progress: m.adaptive_column_progress,
  orderPlaced: m.adaptive_column_order_placed,
  units: m.adaptive_column_units,
  listings: m.adaptive_column_listings,
  missing: m.adaptive_column_missing,
  onHand: m.adaptive_column_on_hand,
  reserved: m.adaptive_column_reserved,
  available: m.adaptive_column_available,
  incoming: m.adaptive_column_incoming,
  expected: m.adaptive_column_expected,
  nextOwner: m.adaptive_column_next_owner,
  requested: m.adaptive_column_requested,
  deadline: m.adaptive_column_deadline,
  impact: m.adaptive_column_impact,
  displayNumber: m.adaptive_column_display_number,
  status: m.adaptive_column_status,
  paymentStatus: m.adaptive_column_payment_status,
  fulfillment: m.adaptive_column_fulfillment,
  placedAt: m.adaptive_column_placed_at,
  dueAt: m.adaptive_column_due_at,
  total: m.adaptive_column_total,
  lineCount: m.adaptive_column_line_count,
  overdue: m.adaptive_column_overdue,
  differs: m.adaptive_column_differs,
  observedAt: m.adaptive_column_observed_at,
  sku: m.adaptive_column_sku,
  location: m.adaptive_column_location,
  unit: m.adaptive_column_unit,
  sources: m.adaptive_column_sources,
  differences: m.adaptive_column_differences,
  sync: m.adaptive_column_sync,
  kind: m.adaptive_column_kind,
  orderLabel: m.adaptive_column_order_label,
  stage: m.adaptive_column_stage,
  displayName: m.adaptive_column_display_name,
  email: m.adaptive_column_email,
  state: m.adaptive_column_state,
  orderCount: m.adaptive_column_order_count,
  createdAt: m.adaptive_column_created_at,
  updatedAt: m.adaptive_column_updated_at,
  title: m.adaptive_column_title,
  supplierName: m.adaptive_column_supplier_name,
  reference: m.adaptive_column_reference,
  confirmationDueAt: m.adaptive_column_confirmation_due_at,
  attentionKey: m.adaptive_column_attention_key,
  nextCheckAt: m.adaptive_column_next_check_at,
  class: m.adaptive_column_class,
  severity: m.adaptive_column_severity,
  summary: m.adaptive_column_summary,
  subject: m.adaptive_column_subject,
  detectedAt: m.adaptive_column_detected_at,
  lastActivityAt: m.adaptive_column_last_activity_at,
  owner: m.adaptive_column_owner,
  attention: m.adaptive_column_attention,
  domain: m.adaptive_column_domain,
  reason: m.adaptive_column_reason,
  response: m.adaptive_column_response,
  assignment: m.adaptive_column_assignment,
  record_count: m.adaptive_column_record_count,
  count_by_group: m.adaptive_column_count_by_group,
  q: m.adaptive_column_q,
  view: m.adaptive_column_view,
  connectionId: m.adaptive_column_connection_id,
  customerId: m.adaptive_column_customer_id,
  locationId: m.adaptive_column_location_id,
  stockBlocked: m.adaptive_column_stock_blocked,
  supplierId: m.adaptive_column_supplier_id,
};

/** Names known query fields in the interface language and preserves unknown extension labels. */
export function columnLabel(key: string) {
  return (
    columnMessages[key]?.() ??
    key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
  );
}

const orderOptions: Record<string, Record<string, string>> = {
  status: statusLabels,
  paymentStatus: paymentLabels,
  fulfillment: fulfillmentLabels,
};

/** Names a catalog option of a field, such as an order status, in the interface language. */
export function optionLabel(
  domain: CollectionDomain,
  field: string,
  option: string,
) {
  return (
    (domain === 'orders' ? orderOptions[field]?.[option] : undefined) ??
    option.replaceAll('_', ' ')
  );
}

/** Returns a record link only for an owner identifier, never a model-supplied external URL. */
export function recordDestination(
  organizationId: string,
  domain: CollectionDomain,
  row: Record<string, unknown>,
) {
  const id =
    typeof row.id === 'string'
      ? row.id
      : typeof row.entityId === 'string'
        ? row.entityId
        : null;
  if (!id || !previewable(domain)) return null;
  if (domain === 'decisions')
    return `/app/${encodeURIComponent(organizationId)}/needs-you?item=${encodeURIComponent(id)}`;
  const segment: Record<AdaptiveViewDomain, string> = {
    orders: 'orders',
    inventory: 'inventory',
    fulfillment: 'fulfillment',
    customers: 'customers',
    products: 'products',
    procurement: 'procurement',
    issues: 'exceptions',
    decisions: 'needs-you',
    returns: 'returns',
  };

  return `/app/${encodeURIComponent(organizationId)}/${segment[domain]}/${encodeURIComponent(id)}`;
}

const customColumnTypes: Record<
  CustomField['type'],
  CustomFieldColumn['type']
> = {
  text: 'text',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
  single_choice: 'enum',
  multi_choice: 'tags',
  person: 'person',
};

/**
 * Describes custom fields for a list's condition builder, Sort and Display menus, with labels
 * and choices in the interface language. Archived fields stay listed so views using them show
 * as needing repair.
 */
export function customFieldColumns(
  fields: readonly CustomField[],
): CustomFieldColumn[] {
  return fields.map((field) => ({
    id: field.id,
    label: adaptiveLabel(field.label),
    type: customColumnTypes[field.type],
    ...(field.choices.length
      ? {
          options: field.choices.map((choice) => ({
            value: choice.key,
            label: adaptiveLabel(choice.label),
          })),
        }
      : {}),
    archived: field.archived,
  }));
}

/**
 * A custom field value as a list cell shows it: choice labels, yes or no, formatted numbers
 * and calendar days. An unset value shows the empty marker, never zero or no.
 */
export function customFieldText(
  column: Pick<CustomFieldColumn, 'type' | 'options'>,
  value: unknown,
): string {
  if (value === null || value === undefined || value === '')
    return m.common_empty_value();
  const option = (key: unknown) =>
    column.options?.find((item) => item.value === key)?.label ?? String(key);
  if (Array.isArray(value))
    return value.length ? value.map(option).join(', ') : m.common_empty_value();
  if (column.type === 'enum') return option(value);
  if (typeof value === 'boolean') return value ? m.common_yes() : m.common_no();
  if (typeof value === 'number') return formatNumber(value);
  if (column.type === 'date' && typeof value === 'string')
    return new Intl.DateTimeFormat(getLocale(), {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));

  return String(value);
}
