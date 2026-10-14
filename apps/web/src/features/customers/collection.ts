import type {
  CollectionCondition,
  CollectionGranularity,
  CollectionGroup,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import type {
  CatalogPresentation,
  RuntimeOptions,
} from '../../kit/collections/fields';
import { anyOf } from '../../kit/collections/legacy';
import { stateLabels } from './presentation';

const customer = () => m.customers_area_customer();
const orders = () => m.customers_area_orders();
const source = () => m.customers_area_source();

/** How the Customers list names each catalog field and its options. */
export const customersPresentation: CatalogPresentation = {
  name: { label: m.customers_column_customer, group: customer },
  email: { label: m.customers_fact_email, group: customer },
  phone: { label: m.customers_fact_phone, group: customer },
  state: {
    label: m.customers_column_account,
    group: customer,
    option: (value) =>
      (stateLabels as Readonly<Record<string, string>>)[value] ?? value,
  },
  tags: { label: m.customers_fact_tags, group: customer },
  country: {
    label: m.customers_field_country,
    description: m.customers_field_country_description,
    group: customer,
  },
  contactShared: {
    label: m.customers_field_contact_shared,
    description: m.customers_field_contact_shared_description,
    group: customer,
  },
  orders: { label: m.customers_column_orders, group: orders },
  spent: { label: m.customers_column_spent, group: orders },
  lastOrder: {
    label: m.customers_sort_last_order,
    description: m.customers_field_last_order_description,
    group: orders,
  },
  source: { label: m.customers_fact_source, group: source },
  created: { label: m.customers_column_since, group: source },
  updated: { label: m.customers_fact_updated, group: source },
  missing: {
    label: m.customers_field_missing,
    description: m.customers_field_missing_description,
    group: source,
  },
};

/** Names a built-in Customers view; the list has one, with every customer. */
export function customerSegmentLabel(segment: string) {
  return segment === 'all' ? m.customers_view_all() : segment;
}

/**
 * Names one group of the Customers list: an account state, a source's name, a tag or country as
 * reported, a calendar period in the workspace time zone (the server returns the period's first
 * day), or "No value" for customers without one.
 */
export function customerGroupLabel(
  field: string,
  granularity: CollectionGranularity | undefined,
  key: CollectionGroup['key'],
  options: RuntimeOptions = {},
): string {
  if (key === null) return m.collections_group_none();
  const presentation = customersPresentation[field];
  if (typeof key === 'boolean')
    return m.collections_group_boolean({
      field: presentation?.label() ?? field,
      value: key ? m.common_yes() : m.common_no(),
    });
  const text = String(key);
  if (field === 'source')
    return (
      options.connections?.find((option) => option.value === text)?.label ??
      m.customers_source_fallback()
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

/** URL keys of Customers links from before configurable views. */
export interface LegacyCustomerSearch {
  state?: string | undefined;
  /** A source filter, unless it names the source of a linked `customerId`. */
  connectionId?: string | undefined;
  customerId?: string | undefined;
}

/** Converts the filters older links use into conditions that select the same customers. */
export function legacyCustomerConditions(
  search: LegacyCustomerSearch,
): CollectionCondition[] {
  const conditions: CollectionCondition[] = [];
  if (search.state) conditions.push(anyOf('state', search.state));
  if (search.connectionId && !search.customerId)
    conditions.push(anyOf('source', search.connectionId));

  return conditions;
}
