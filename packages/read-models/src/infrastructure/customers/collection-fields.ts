import type { Permission } from '@luma/identity';

import type { CollectionCondition } from '../../application/collections.js';
import {
  type CustomerSort,
  customerStates,
} from '../../application/customers.js';
import type { CollectionGroupFieldSql } from '../collection/group.js';
import type { CollectionSortSql } from '../collection/keyset.js';
import {
  type CollectionCompileContext,
  type CollectionFieldMap,
  conditionValues,
} from '../collection/where.js';

// Every fragment reads a customer_profiles row `o`.

/** Countries compare case-insensitively with the stored upper-case value. */
function countryPredicate(
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  const { op } = condition;
  const one = (value: unknown) =>
    context.parameters.bind(String(value).toUpperCase(), 'text');
  const many = () =>
    context.parameters.bind(
      conditionValues(condition, 'text', context).map((value) =>
        String(value).toUpperCase(),
      ),
      'text[]',
    );
  if (op === 'is') return `o.country=${one(condition.value)}`;
  if (op === 'is_not')
    return `(o.country IS NULL OR o.country<>${one(condition.value)})`;
  if (op === 'any_of') return `o.country=ANY(${many()})`;
  if (op === 'none_of')
    return `(o.country IS NULL OR o.country<>ALL(${many()}))`;

  return undefined;
}

/**
 * Customers catalog fields as SQL over the profile row. A country the source does not share
 * is unknown, so it matches neither a value nor `empty`. Missing means a complete full read of
 * the source no longer found the customer.
 */
export const customerCollectionFields: CollectionFieldMap = {
  state: { type: 'enum', sql: 'o.state' },
  source: { type: 'reference', sql: 'o.connection_id', cast: 'uuid' },
  created: { type: 'date', sql: 'o.source_created_at' },
  updated: { type: 'date', sql: 'o.source_updated_at' },
  orders: { type: 'number', sql: 'o.order_count', cast: 'integer' },
  spent: { type: 'money', sql: 'o.amount_spent', currency: 'o.currency' },
  tags: { type: 'tags', sql: 'o.tags' },
  country: {
    type: 'text',
    sql: 'o.country',
    unknown: 'NOT o.address_shared',
    predicate: countryPredicate,
  },
  lastOrder: { type: 'date', sql: 'o.last_order_at' },
  missing: {
    type: 'boolean',
    sql: `EXISTS (SELECT 1 FROM commerce_sync_items i WHERE i.tenant_id=o.tenant_id
 AND i.connection_id=o.connection_id AND i.record_type='customers' AND i.resource='customer'
 AND i.scope_key='' AND i.external_id=o.external_id AND i.missing_since IS NOT NULL)`,
  },
  contactShared: { type: 'boolean', sql: 'o.contact_shared' },
};

/** Permissions a condition, group or sort field needs beyond `customers.read`. */
export const customerFieldPermissions: Readonly<
  Record<string, readonly Permission[]>
> = { lastOrder: ['orders.read'] };

/** Groupable Customers fields. A customer counts once in each of its tags' groups. */
export const customerGroupFields: Readonly<
  Record<string, CollectionGroupFieldSql>
> = {
  state: { key: 'o.state', cast: 'text', order: { options: customerStates } },
  source: { key: 'o.connection_id', cast: 'uuid', order: 'asc' },
  tags: {
    keys: 'SELECT DISTINCT tag AS key FROM unnest(o.tags) tag',
    cast: 'text',
    order: 'asc',
  },
  country: { key: 'o.country', cast: 'text', order: 'asc' },
  created: { date: 'o.source_created_at', cast: 'timestamptz', order: 'asc' },
  lastOrder: { date: 'o.last_order_at', cast: 'timestamptz', order: 'asc' },
};

const optional = (
  sql: string,
  cast: CollectionSortSql['keys'][number]['cast'],
): CollectionSortSql => ({
  present: `${sql} IS NOT NULL`,
  missing: `${sql} IS NULL`,
  keys: [{ sql, cast }],
});

/**
 * Sorting by each Customers sort; profiles without the value come last in both directions.
 * Amount spent orders by currency, then amount. Names are capped so a cursor can carry them.
 */
export const customerSorts: Readonly<Record<CustomerSort, CollectionSortSql>> =
  {
    created: optional('o.source_created_at', 'timestamptz'),
    orders: optional('o.order_count', 'integer'),
    name: {
      present: 'o.display_name IS NOT NULL',
      missing: 'o.display_name IS NULL',
      keys: [{ sql: 'left(lower(o.display_name),150)', cast: 'text' }],
    },
    amountSpent: {
      present: 'o.amount_spent IS NOT NULL',
      missing: 'o.amount_spent IS NULL',
      keys: [
        { sql: 'o.currency', cast: 'text' },
        { sql: 'o.amount_spent', cast: 'numeric' },
      ],
    },
    updated: optional('o.source_updated_at', 'timestamptz'),
    lastOrder: optional('o.last_order_at', 'timestamptz'),
  };
