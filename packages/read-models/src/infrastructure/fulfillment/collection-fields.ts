import type { CollectionCondition } from '../../application/collections.js';
import type {
  FulfillmentQuery,
  FulfillmentSort,
} from '../../application/fulfillment.js';
import {
  fulfillmentDeliveryStates,
  fulfillmentMethodTypes,
  fulfillmentShippingStages,
  fulfillmentSignals,
  fulfillmentStatuses,
} from '../../application/fulfillment.js';
import type { CollectionGroupFieldSql } from '../collection/group.js';
import type { CollectionSortSql } from '../collection/keyset.js';
import { collectionQueryError, likePattern } from '../collection/parameters.js';
import type {
  CollectionCompileContext,
  CollectionFieldMap,
} from '../collection/where.js';

// Every fragment reads a classified fulfillment row `o` (see `classified` in rules.ts), whose
// rule columns `held`, `overdue`, `stalled`, `delivery_issue`, `late_delivery` and `failed`
// are evaluated at the list's read time.

/** The row's signals in catalog order. */
const signals = `array_remove(ARRAY[${fulfillmentSignals
  .map((signal) => `CASE WHEN o.${signal} THEN '${signal}' END`)
  .join(',')}]::text[],NULL)`;

/** Carrier conditions compare names case-insensitively against every tracking carrier. */
function carrierPredicate(
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  const { op, value } = condition;
  const any = (test: string) =>
    `EXISTS (SELECT 1 FROM unnest(o.carriers) carrier WHERE ${test})`;
  if (op === 'empty') return 'cardinality(o.carriers)=0';
  if (op === 'not_empty') return 'cardinality(o.carriers)>0';
  if (op === 'contains' || op === 'not_contains') {
    if (typeof value !== 'string') throw collectionQueryError('Expected text');
    const match = any(
      `carrier ILIKE ${context.parameters.bind(likePattern(value), 'text')}`,
    );

    return op === 'contains' ? match : `NOT ${match}`;
  }
  if (op === 'is' || op === 'is_not') {
    if (typeof value !== 'string') throw collectionQueryError('Expected text');
    const match = any(
      `lower(carrier)=${context.parameters.bind(value.toLowerCase(), 'text')}`,
    );

    return op === 'is' ? match : `NOT ${match}`;
  }
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Fulfillment catalog fields as SQL over a classified row. Holds are unknown when the source
 * does not report them; every other missing value is empty.
 */
export const fulfillmentCollectionFields: CollectionFieldMap = {
  source: { type: 'reference', sql: 'o.connection_id', cast: 'uuid' },
  location: { type: 'reference', sql: 'o.location_id', cast: 'uuid' },
  kind: { type: 'enum', sql: 'o.kind' },
  status: { type: 'enum', sql: 'o.status' },
  signals: { type: 'tags', sql: signals },
  holds: {
    type: 'tags',
    sql: 'o.hold_reasons',
    unknown: 'o.hold_reasons IS NULL',
  },
  delivery: { type: 'enum', sql: 'o.delivery' },
  carrier: { type: 'text', predicate: carrierPredicate },
  method: { type: 'text', sql: 'o.method_name' },
  methodType: { type: 'enum', sql: 'o.method_type' },
  stage: { type: 'enum', sql: 'o.shipping_stage' },
  hasTracking: { type: 'boolean', sql: '(cardinality(o.tracking_numbers)>0)' },
  fulfillBy: { type: 'date', sql: 'o.fulfill_by' },
  estimatedDelivery: { type: 'date', sql: 'o.estimated_delivery_at' },
  orderPlaced: { type: 'date', sql: 'o.order_placed_at' },
  progress: { type: 'date', sql: 'o.progress_at' },
};

/** Groupable Fulfillment fields; enumerations follow the catalog's option order. */
export const fulfillmentGroupFields: Readonly<
  Record<string, CollectionGroupFieldSql>
> = {
  status: {
    key: 'o.status',
    cast: 'text',
    order: { options: fulfillmentStatuses },
  },
  signals: {
    keys: `SELECT signal AS key FROM unnest(${signals}) signal`,
    cast: 'text',
    order: { options: fulfillmentSignals },
  },
  stage: {
    key: 'o.shipping_stage',
    cast: 'text',
    order: { options: fulfillmentShippingStages },
  },
  delivery: {
    key: 'o.delivery',
    cast: 'text',
    order: { options: fulfillmentDeliveryStates },
  },
  kind: {
    key: 'o.kind',
    cast: 'text',
    order: { options: ['fulfillment_order', 'shipment'] },
  },
  source: { key: 'o.connection_id', cast: 'uuid', order: 'asc' },
  location: { key: 'o.location_id', cast: 'uuid', order: 'asc' },
  carrier: {
    keys: 'SELECT DISTINCT carrier AS key FROM unnest(o.carriers) carrier',
    cast: 'text',
    order: 'asc',
  },
  method: { key: 'o.method_name', cast: 'text', order: 'asc' },
  methodType: {
    key: 'o.method_type',
    cast: 'text',
    order: { options: fulfillmentMethodTypes },
  },
  fulfillBy: { date: 'o.fulfill_by', cast: 'timestamptz', order: 'asc' },
  estimatedDelivery: {
    date: 'o.estimated_delivery_at',
    cast: 'timestamptz',
    order: 'asc',
  },
  orderPlaced: {
    date: 'o.order_placed_at',
    cast: 'timestamptz',
    order: 'asc',
  },
};

/** The direction a fulfillment sort uses when the query names none. */
export const fulfillmentDirection = (query: FulfillmentQuery) =>
  query.direction ??
  (query.sort === 'recent' || query.sort === 'orderPlaced' ? 'desc' : 'asc');

const dated = (sql: string): CollectionSortSql => ({
  present: `${sql} IS NOT NULL`,
  missing: `${sql} IS NULL`,
  keys: [{ sql, cast: 'timestamptz' }],
});

/** Text keys are capped so a cursor can carry them; longer values tie and order by ID. */
const named = (sql: string): CollectionSortSql => ({
  present: `${sql} IS NOT NULL`,
  missing: `${sql} IS NULL`,
  keys: [{ sql: `left(${sql},150)`, cast: 'text' }],
});

/**
 * Sorting by each fulfillment sort in `direction`; missing values come last in both
 * directions. `deadline` orders work with a deadline first and undated work after it by last
 * progress, so its first key flips with the direction instead of using the missing rank.
 */
export function fulfillmentSort(
  sort: FulfillmentSort,
  direction: 'asc' | 'desc',
): CollectionSortSql {
  const progress = {
    present: 'true',
    missing: 'false',
    keys: [{ sql: 'o.progress_at', cast: 'timestamptz' }],
  } as const;
  if (sort === 'waiting' || sort === 'recent') return progress;
  if (sort === 'deadline')
    return {
      present: 'true',
      missing: 'false',
      keys: [
        {
          sql:
            direction === 'asc'
              ? '(o.deadline_at IS NULL)::int'
              : '(o.deadline_at IS NOT NULL)::int',
          cast: 'integer',
        },
        { sql: 'COALESCE(o.deadline_at,o.progress_at)', cast: 'timestamptz' },
      ],
    };
  if (sort === 'fulfillBy') return dated('o.fulfill_by');
  if (sort === 'estimatedDelivery') return dated('o.estimated_delivery_at');
  if (sort === 'orderPlaced') return dated('o.order_placed_at');
  if (sort === 'orderNumber') return named('o.order_number');

  return named('lower(o.location_name)');
}
