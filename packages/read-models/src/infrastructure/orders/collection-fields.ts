import type { Permission } from '@luma/identity';

import type { CollectionCondition } from '../../application/collections.js';
import {
  orderComparisonStates,
  orderFulfillmentStates,
  orderPaymentStatuses,
  type OrderSort,
  orderStatuses,
} from '../../application/orders.js';
import type { CollectionGroupFieldSql } from '../collection/group.js';
import type { CollectionSortSql } from '../collection/keyset.js';
import { collectionQueryError } from '../collection/parameters.js';
import {
  type CollectionCompileContext,
  type CollectionFieldMap,
  conditionValues,
} from '../collection/where.js';
import type { OrderReadQueries } from './list-query.js';

// Every fragment reads the orders_list row `o` inside the list query, where $1 is the tenant,
// $2 the read time and `order_state` holds progress for rows whose evidence is newer than $2.

/** Current state of a row: maintained columns, or read-time progress for future evidence. */
const current = (column: 'open' | 'fulfillment') =>
  `CASE WHEN o.state_valid_from>$2 THEN (SELECT f.${column} FROM order_state f WHERE f.entity_id=o.entity_id AND f.connection_id=o.connection_id) ELSE o.${column} END`;

const open = current('open');

/** Overdue under `orders.overdue` v1: open and past due; unknown while open is unknown. */
const overdue = `CASE WHEN (${open})=false THEN false WHEN (${open}) IS NULL OR o.due_at IS NULL THEN NULL ELSE o.due_at<$2 END`;

const needsYou = `(NOT o.deleted AND o.entity_id IN (SELECT order_id FROM needs_you_orders))`;

/**
 * FROM and WHERE clauses for the order's open fulfillment work `f` through an active,
 * installed source that still grants fulfillment reads. `extra` narrows `f`.
 */
const fulfillmentRows = (extra: string) =>
  `FROM orders_fulfillment_list f JOIN connector_installations c ON c.tenant_id=f.tenant_id AND c.id=f.connection_id JOIN workspace_apps app ON app.tenant_id=c.tenant_id AND app.app_id=c.document->>'appId' AND app.status='installed' WHERE f.tenant_id=$1 AND f.order_id=o.entity_id AND f.open AND NOT f.deleted AND c.document->>'status'='active' AND c.document->'granted' ? 'fulfillment.read' ${extra}`;

/** True when the order has open fulfillment work as `fulfillmentRows` defines it. */
export function openFulfillment(extra = '') {
  return `EXISTS(SELECT 1 ${fulfillmentRows(extra)})`;
}

/** An explicit source out-of-stock hold observed within five minutes of the read. */
export const freshStockHold =
  "AND f.hold_reasons @> ARRAY['inventory_out_of_stock']::text[] AND f.observed_at<=$2 AND f.observed_at>=$2::timestamptz-interval '5 minutes'";

/** Orders the given imported customer profiles bought, as their sources attribute them. */
function customerOrders(profiles: string) {
  return `o.entity_id IN (SELECT m.canonical_id FROM customer_profiles p
     JOIN customer_orders c ON c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id AND c.customer_external_id=p.external_id
     JOIN connector_source_mappings m ON m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id
      AND m.resource='order' AND m.scope_key=c.order_scope_key AND m.external_id=c.order_external_id
     WHERE p.tenant_id=$1 AND p.id=ANY(${profiles}))`;
}

/**
 * Position of a value in a fixed option list; other values rank after every option. Status
 * and payment indexes repeat these expressions; change both together.
 */
function optionRank(sql: string, options: readonly string[]) {
  if (options.some((option) => !/^[a-z_]+$/.test(option)))
    throw new Error('Option ranks accept only lowercase option IDs');

  return `COALESCE(array_position(ARRAY[${options.map((option) => `'${option}'`).join(',')}]::text[],${sql}),${options.length + 1})`;
}

function referencePredicate(
  any: (values: string) => string,
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  const values = context.parameters.bind(
    conditionValues(condition, 'uuid', context),
    'uuid[]',
  );
  if (condition.op === 'any_of') return any(values);
  if (condition.op === 'none_of') return `NOT ${any(values)}`;
  throw collectionQueryError('This field does not support this operator');
}

/** Conditions on the stock-blocked flag; false needs fresh evidence of every open fulfillment. */
function stockBlockedPredicate(condition: CollectionCondition) {
  if (condition.value === true) return openFulfillment(freshStockHold);
  if (condition.value === false)
    return `(${openFulfillment()} AND NOT ${openFulfillment(
      `AND (f.hold_reasons @> ARRAY['inventory_out_of_stock']::text[] OR f.observed_at>$2 OR f.observed_at<$2::timestamptz-interval '5 minutes')`,
    )})`;
  throw collectionQueryError('Expected true or false');
}

type FacetKind = 'tag' | 'discount_code' | 'shipping_method';

/** True when the row's current snapshot reports a value of this kind, narrowed by `extra`. */
const facet = (kind: FacetKind, extra = '') =>
  `EXISTS(SELECT 1 FROM orders_list_facets t WHERE t.tenant_id=$1 AND t.entity_id=o.entity_id AND t.connection_id=o.connection_id AND t.kind='${kind}' ${extra})`;

/** Conditions on tags, discount codes or shipping methods, read from the value postings. */
function facetPredicate(kind: FacetKind) {
  return (
    condition: CollectionCondition,
    context: CollectionCompileContext,
  ) => {
    if (condition.op === 'empty') return `NOT ${facet(kind)}`;
    if (condition.op === 'not_empty') return facet(kind);
    const values = context.parameters.bind(
      conditionValues(condition, 'text', context),
      'text[]',
    );
    if (condition.op === 'any_of')
      return facet(kind, `AND t.value=ANY(${values})`);
    if (condition.op === 'none_of')
      return `NOT ${facet(kind, `AND t.value=ANY(${values})`)}`;
    if (condition.op === 'all_of')
      return `(SELECT count(DISTINCT t.value) FROM orders_list_facets t WHERE t.tenant_id=$1 AND t.entity_id=o.entity_id AND t.connection_id=o.connection_id AND t.kind='${kind}' AND t.value=ANY(${values}))=cardinality(${values})`;
    throw collectionQueryError('This field does not support this operator');
  };
}

/** Shipping addresses a source shared for the order; addresses it did not share stay unknown. */
const sharedShipping = (extra: string) =>
  `EXISTS(SELECT 1 FROM connector_source_mappings m JOIN customer_order_addresses a ON a.tenant_id=m.tenant_id AND a.connection_id=m.connection_id AND a.order_scope_key=m.scope_key AND a.order_external_id=m.external_id WHERE m.tenant_id=$1 AND m.resource='order' AND m.canonical_id=o.entity_id AND a.shared ${extra})`;

/** Ship-to country conditions; an order without a shared address never matches either way. */
function countryPredicate(
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  const codes = conditionValues(condition, 'text', context).map((value) =>
    String(value).toUpperCase(),
  );
  const values = context.parameters.bind(codes, 'text[]');
  if (condition.op === 'any_of')
    return sharedShipping(`AND upper(a.shipping->>'country')=ANY(${values})`);
  if (condition.op === 'none_of')
    return `(${sharedShipping(`AND a.shipping->>'country' IS NOT NULL`)} AND NOT ${sharedShipping(`AND upper(a.shipping->>'country')=ANY(${values})`)})`;
  throw collectionQueryError('This field does not support this operator');
}

/** Query parts that Orders field SQL may read, by `requires` name. */
export type OrderFieldPart = 'needsYou' | 'hasIssue';

/**
 * Orders catalog fields as SQL over the orders_list row. Field IDs, option orders and
 * permissions follow the Orders catalog; callers check permissions before compiling.
 */
export function orderCollectionFields(
  queries: OrderReadQueries,
): CollectionFieldMap {
  return {
    placed: { type: 'date', sql: 'o.placed_at' },
    updated: { type: 'date', sql: 'o.source_updated_at' },
    due: { type: 'date', sql: 'o.due_at' },
    status: { type: 'enum', sql: 'o.status' },
    paymentStatus: { type: 'enum', sql: 'o.payment_status' },
    fulfillment: { type: 'enum', sql: current('fulfillment') },
    total: {
      type: 'money',
      sql: 'o.total_amount',
      currency: 'o.total_currency',
    },
    lineCount: { type: 'number', sql: 'o.line_count' },
    source: {
      type: 'reference',
      predicate: (condition, context) =>
        referencePredicate(
          (values) =>
            `EXISTS(SELECT 1 FROM orders_list s WHERE s.tenant_id=$1 AND s.entity_id=o.entity_id AND s.connection_id=ANY(${values}))`,
          condition,
          context,
        ),
    },
    comparison: { type: 'enum', sql: queries.state.comparisonState('o') },
    overdue: { type: 'boolean', sql: overdue },
    needsYou: { type: 'boolean', sql: needsYou, requires: ['needsYou'] },
    hasIssue: {
      type: 'boolean',
      sql: 'o.entity_id IN (SELECT order_id FROM issue_orders)',
      requires: ['hasIssue'],
    },
    warehouse: {
      type: 'reference',
      predicate: (condition, context) =>
        referencePredicate(
          (values) => openFulfillment(`AND f.location_id=ANY(${values})`),
          condition,
          context,
        ),
    },
    stockBlocked: {
      type: 'boolean',
      predicate: (condition) => stockBlockedPredicate(condition),
    },
    customer: {
      type: 'reference',
      predicate: (condition, context) =>
        referencePredicate(customerOrders, condition, context),
    },
    channel: { type: 'text', sql: 'o.channel' },
    currency: { type: 'text', sql: 'o.currency' },
    test: { type: 'boolean', sql: 'o.test' },
    cancelReason: { type: 'enum', sql: 'o.cancel_reason' },
    tags: { type: 'tags', predicate: facetPredicate('tag') },
    discountCode: { type: 'tags', predicate: facetPredicate('discount_code') },
    shippingMethod: {
      type: 'tags',
      predicate: facetPredicate('shipping_method'),
    },
    country: { type: 'text', predicate: countryPredicate },
  };
}

/** Permissions a filter or group field needs beyond `orders.read`. */
export const orderFieldPermissions: Readonly<
  Record<string, readonly Permission[]>
> = {
  warehouse: ['fulfillment.read'],
  stockBlocked: ['inventory.read', 'fulfillment.read'],
  customer: ['customers.read'],
  country: ['customers.read'],
};

/** Groupable Orders fields. */
export function orderGroupFields(
  queries: OrderReadQueries,
): Readonly<
  Record<
    string,
    CollectionGroupFieldSql & { requires?: readonly OrderFieldPart[] }
  >
> {
  return {
    status: {
      key: 'o.status',
      cast: 'text',
      order: { options: orderStatuses },
    },
    paymentStatus: {
      key: 'o.payment_status',
      cast: 'text',
      order: { options: orderPaymentStatuses },
    },
    fulfillment: {
      key: current('fulfillment'),
      cast: 'text',
      order: { options: orderFulfillmentStates },
    },
    comparison: {
      key: queries.state.comparisonState('o'),
      cast: 'text',
      order: { options: orderComparisonStates },
    },
    source: {
      keys: 'SELECT s.connection_id AS key FROM orders_list s WHERE s.tenant_id=$1 AND s.entity_id=o.entity_id',
      cast: 'uuid',
      order: 'asc',
    },
    overdue: { key: overdue, cast: 'boolean', order: 'true_first' },
    needsYou: {
      key: needsYou,
      cast: 'boolean',
      order: 'true_first',
      requires: ['needsYou'],
    },
    warehouse: {
      keys: `SELECT DISTINCT f.location_id AS key ${fulfillmentRows('AND f.location_id IS NOT NULL')}`,
      cast: 'uuid',
      order: 'asc',
    },
    channel: { key: 'o.channel', cast: 'text', order: 'asc' },
    currency: { key: 'o.currency', cast: 'text', order: 'asc' },
    test: { key: 'o.test', cast: 'boolean', order: 'true_first' },
    cancelReason: {
      key: 'o.cancel_reason',
      cast: 'text',
      order: {
        options: [
          'customer',
          'declined',
          'fraud',
          'inventory',
          'staff',
          'other',
          'unknown',
        ],
      },
    },
    tags: {
      keys: "SELECT t.value AS key FROM orders_list_facets t WHERE t.tenant_id=$1 AND t.entity_id=o.entity_id AND t.connection_id=o.connection_id AND t.kind='tag'",
      cast: 'text',
      order: 'asc',
    },
    shippingMethod: {
      keys: "SELECT t.value AS key FROM orders_list_facets t WHERE t.tenant_id=$1 AND t.entity_id=o.entity_id AND t.connection_id=o.connection_id AND t.kind='shipping_method'",
      cast: 'text',
      order: 'asc',
    },
    placed: { date: 'o.placed_at', cast: 'timestamptz', order: 'asc' },
    due: { date: 'o.due_at', cast: 'timestamptz', order: 'asc' },
  };
}

/** Sorting by each Orders sort field; missing values come last in both directions. */
export const orderSorts: Readonly<Record<OrderSort, CollectionSortSql>> = {
  // Maintained rank and key columns with dedicated indexes.
  updated: maintainedSort('updated'),
  placed: maintainedSort('placed'),
  number: maintainedSort('number'),
  due: maintainedSort('due'),
  // Amounts never compare across currencies: rows group by currency code, then amount, both
  // in the sort direction.
  total: {
    present: 'o.total_amount IS NOT NULL',
    missing: 'o.total_amount IS NULL',
    keys: [
      { sql: 'o.total_currency', cast: 'text' },
      { sql: 'o.total_amount', cast: 'numeric' },
    ],
  },
  status: optionSort('o.status', orderStatuses),
  paymentStatus: optionSort('o.payment_status', orderPaymentStatuses),
  fulfillment: optionSort(current('fulfillment'), orderFulfillmentStates),
  lineCount: {
    present: 'o.line_count IS NOT NULL',
    missing: 'o.line_count IS NULL',
    keys: [{ sql: 'o.line_count', cast: 'integer' }],
  },
};

function maintainedSort(sort: string): CollectionSortSql {
  return {
    present: `o.${sort}_rank=0`,
    missing: `o.${sort}_rank=1`,
    keys: [{ sql: `o.${sort}_key`, cast: 'text' }],
  };
}

function optionSort(
  sql: string,
  options: readonly string[],
): CollectionSortSql {
  // These columns always hold a value, so every row ranks and none is missing. Row security
  // keeps a null test on this expression from using the index.
  return {
    present: 'true',
    missing: 'false',
    keys: [{ sql: optionRank(sql, options), cast: 'integer' }],
  };
}
