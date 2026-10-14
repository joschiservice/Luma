import type {
  CollectionGranularity,
  CollectionGroup,
  OrderStage,
  PurchaseOrderStatus,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { ownerLabels, stages, statusLabels } from './presentation';

const order = () => m.procurement_area_order();
const progress = () => m.procurement_area_progress();
const lines = () => m.procurement_area_lines();

const attentionLabels: Readonly<Record<string, () => string>> = {
  submission_uncertain: m.procurement_attention_submission_uncertain,
  submission_failed: m.procurement_attention_submission_failed,
  review_commitment: m.procurement_attention_review_commitment,
  commitment_changed: m.procurement_attention_commitment_changed,
  confirmation_overdue: m.procurement_attention_confirmation_overdue,
  delivery_overdue: m.procurement_attention_delivery_overdue,
  receipt_difference: m.procurement_attention_receipt_difference,
};

const authorityLabels: Readonly<Record<string, () => string>> = {
  luma: m.procurement_authority_luma,
  external: m.procurement_authority_external,
};

/** Names an open item kind, such as "Confirmation overdue"; unknown kinds show as they are. */
export function attentionLabel(kind: string) {
  return attentionLabels[kind]?.() ?? kind;
}

/** Names whether Luma or an external system manages an order. */
export function authorityLabel(authority: string) {
  return authorityLabels[authority]?.() ?? authority;
}

const stageLabel = (value: string) =>
  value in stages ? stages[value as OrderStage].label : value;

const statusLabel = (value: string) =>
  value in statusLabels ? statusLabels[value as PurchaseOrderStatus]() : value;

const ownerLabel = (value: string) =>
  value in ownerLabels
    ? ownerLabels[value as keyof typeof ownerLabels]()
    : value;

/** How the purchase-order list names each catalog field and its options. */
export const purchaseOrdersPresentation: CatalogPresentation = {
  reference: { label: m.procurement_column_purchase_order, group: order },
  number: { label: m.procurement_field_number, group: order },
  supplier: { label: m.procurement_column_supplier, group: order },
  status: {
    label: m.procurement_field_status,
    group: order,
    option: statusLabel,
  },
  authority: {
    label: m.procurement_field_authority,
    group: order,
    option: authorityLabel,
  },
  created: { label: m.procurement_field_created, group: order },
  updated: { label: m.procurement_field_updated, group: order },
  value: {
    label: m.procurement_field_value,
    description: m.procurement_field_value_description,
    group: order,
  },
  stage: {
    label: m.procurement_column_stage,
    description: m.procurement_field_stage_description,
    group: progress,
    option: stageLabel,
  },
  attention: {
    label: m.procurement_field_attention,
    description: m.procurement_field_attention_description,
    group: progress,
    option: attentionLabel,
  },
  nextOwner: {
    label: m.procurement_column_owner,
    group: progress,
    option: ownerLabel,
  },
  expected: { label: m.procurement_column_expected, group: progress },
  confirmationDue: {
    label: m.procurement_field_confirmation_due,
    group: progress,
  },
  nextCheck: {
    label: m.procurement_field_next_check,
    description: m.procurement_field_next_check_description,
    group: progress,
  },
  lines: { label: m.procurement_field_lines, group: lines },
  sku: {
    label: m.procurement_field_sku,
    description: m.procurement_field_sku_description,
    group: lines,
  },
  location: {
    label: m.procurement_field_location,
    description: m.procurement_field_location_description,
    group: lines,
  },
};

/** How the supplier list names each catalog field. */
export const suppliersPresentation: CatalogPresentation = {
  name: { label: m.procurement_column_supplier },
  link: { label: m.procurement_column_link },
  references: { label: m.procurement_column_references },
  created: { label: m.procurement_column_added },
  orders: { label: m.procurement_column_orders },
  hasOpenOrders: { label: m.procurement_field_has_open_orders },
  confirmationOverdue: {
    label: m.procurement_field_confirmation_overdue,
    description: m.procurement_field_confirmation_overdue_description,
  },
};

const segmentLabels: Readonly<Record<string, () => string>> = {
  all: m.procurement_list_view_all,
  attention: m.procurement_overview_attention,
  awaiting_confirmation: m.procurement_overview_waiting,
  draft: m.procurement_overview_drafts,
};

/** Names a built-in purchase-order view. */
export function purchaseOrderSegmentLabel(segment: string) {
  return segmentLabels[segment]?.() ?? segment;
}

/** Names the supplier list's only built-in view. */
export function supplierSegmentLabel() {
  return m.procurement_list_view_all_suppliers();
}

/** Fields whose group keys are IDs named by options loaded at run time. */
const runtimeGroups: Readonly<Record<string, keyof RuntimeOptions>> = {
  supplier: 'suppliers',
};

/**
 * Names one group of the purchase-order list: an option's label, a supplier's name, a calendar
 * period in the workspace time zone or "No value" for orders without one.
 */
export function purchaseOrderGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  if (key === null) return m.collections_group_none();
  const presentation = purchaseOrdersPresentation[field];
  if (typeof key === 'boolean')
    return m.collections_group_boolean({
      field: presentation?.label() ?? field,
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
