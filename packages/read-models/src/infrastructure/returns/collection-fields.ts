import {
  returnLifecycle,
  type ReturnQuery,
  returnRefundStates,
} from '../../application/returns.js';
import type { CollectionGroupFieldSql } from '../collection/group.js';
import type { CollectionSortSql } from '../collection/keyset.js';
import type { CollectionFieldMap } from '../collection/where.js';

// Every fragment reads an orders_returns row `o`.

/**
 * Returns catalog fields as SQL over the returns row. Receipt the source does not report is
 * unknown, so partial receipt neither matches nor fails for it. Amounts carry their currency.
 */
export const returnCollectionFields: CollectionFieldMap = {
  kind: { type: 'enum', sql: 'o.kind' },
  stage: { type: 'enum', sql: 'o.stage' },
  refundState: { type: 'enum', sql: 'o.refund_state' },
  failedAttempts: { type: 'number', sql: 'o.failed_attempts', cast: 'integer' },
  reasons: { type: 'tags', sql: 'o.reasons' },
  value: { type: 'money', sql: 'o.value_amount', currency: 'o.value_currency' },
  refund: {
    type: 'money',
    sql: 'o.refunded_amount',
    currency: 'o.currency',
  },
  pendingRefund: {
    type: 'money',
    sql: 'o.pending_amount',
    currency: 'o.currency',
  },
  items: { type: 'number', sql: 'o.quantity' },
  partiallyReceived: {
    type: 'boolean',
    sql: '(o.received>0 AND o.received<o.quantity)',
    unknown: '(o.received IS NULL OR o.quantity IS NULL)',
  },
  requested: { type: 'date', sql: 'o.requested_at' },
  activity: { type: 'date', sql: 'o.activity_at' },
  source: { type: 'reference', sql: 'o.connection_id', cast: 'uuid' },
};

/** Groupable Returns fields: stages in lifecycle order, refund states in catalog order. */
export const returnGroupFields: Readonly<
  Record<string, CollectionGroupFieldSql>
> = {
  stage: { key: 'o.stage', cast: 'text', order: { options: returnLifecycle } },
  refundState: {
    key: 'o.refund_state',
    cast: 'text',
    order: { options: returnRefundStates },
  },
  kind: {
    key: 'o.kind',
    cast: 'text',
    order: { options: ['return', 'refund'] },
  },
  reasons: {
    keys: 'SELECT DISTINCT reason AS key FROM unnest(o.reasons) reason',
    cast: 'text',
    order: 'asc',
  },
  source: { key: 'o.connection_id', cast: 'uuid', order: 'asc' },
  requested: { date: 'o.requested_at', cast: 'timestamptz', order: 'asc' },
};

// Lifecycle position for the stage sort.
const stageRank = `array_position(ARRAY[${returnLifecycle.map((stage) => `'${stage}'`).join(',')}]::text[],o.stage)`;

/**
 * Sorting by each Returns sort; returns without the value come last in both directions.
 * Amounts order by currency, then amount, so they compare only within one currency.
 */
export const returnSorts: Readonly<
  Record<ReturnQuery['sort'], CollectionSortSql>
> = {
  requested: {
    present: 'true',
    missing: 'false',
    keys: [{ sql: 'o.requested_key', cast: 'timestamptz' }],
  },
  activity: {
    present: 'true',
    missing: 'false',
    keys: [{ sql: 'o.activity_at', cast: 'timestamptz' }],
  },
  value: {
    present: 'o.value_amount IS NOT NULL',
    missing: 'o.value_amount IS NULL',
    keys: [
      { sql: 'o.value_currency', cast: 'text' },
      { sql: 'o.value_amount', cast: 'numeric' },
    ],
  },
  // Keys stay null on returns without a pending amount or currency, as missing rows need.
  pendingRefund: {
    present: '(o.pending_amount IS NOT NULL AND o.currency IS NOT NULL)',
    missing: '(o.pending_amount IS NULL OR o.currency IS NULL)',
    keys: [
      {
        sql: 'CASE WHEN o.pending_amount IS NOT NULL THEN o.currency END',
        cast: 'text',
      },
      {
        sql: 'CASE WHEN o.currency IS NOT NULL THEN o.pending_amount END',
        cast: 'numeric',
      },
    ],
  },
  stage: {
    present: 'true',
    missing: 'false',
    keys: [
      { sql: stageRank, cast: 'integer' },
      { sql: 'o.requested_key', cast: 'timestamptz' },
    ],
  },
};
