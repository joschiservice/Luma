import type { AdaptiveViewDomain } from '@luma/api-contract';
import { formatCurrency, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { getLocale } from '@luma/i18n/runtime';

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

/** Makes stable owner field keys readable while retaining unknown keys explicitly. */
const columnMessages: Record<string, () => string> = {
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

/** Returns a record link only for an owner identifier, never a model-supplied external URL. */
export function recordDestination(
  organizationId: string,
  domain: AdaptiveViewDomain,
  row: Record<string, unknown>,
) {
  const id =
    typeof row.id === 'string'
      ? row.id
      : typeof row.entityId === 'string'
        ? row.entityId
        : null;
  if (!id) return null;
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
  };

  return `/app/${encodeURIComponent(organizationId)}/${segment[domain]}/${encodeURIComponent(id)}`;
}
