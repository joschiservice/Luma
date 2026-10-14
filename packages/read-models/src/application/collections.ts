// Structural mirror of the collection query contract (`@luma/api-contract` collections). The
// API layer validates requests against the list catalog; read models only see these shapes.

export type CollectionFieldType =
  | 'text'
  | 'enum'
  | 'tags'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'person'
  | 'reference';

type CollectionOperator =
  | 'is'
  | 'is_not'
  | 'any_of'
  | 'none_of'
  | 'all_of'
  | 'contains'
  | 'not_contains'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'within_last'
  | 'within_next'
  | 'empty'
  | 'not_empty'
  | 'unknown';

export type CollectionGranularity = 'day' | 'week' | 'month';

type CollectionScalar = string | number | boolean;

/** Resolved per reader at read time: `me` is the caller, `today` the caller's local day. */
export interface CollectionDynamicValue {
  dynamic: 'me' | 'today';
}

/** A period of whole local days, weeks or months relative to the read time. */
export interface CollectionRelativeValue {
  amount: number;
  unit: CollectionGranularity;
}

/** A decimal amount in one ISO currency. */
export interface CollectionMoneyValue {
  amount: string;
  currency: string;
}

export type CollectionRangeBound =
  CollectionScalar | CollectionMoneyValue | CollectionDynamicValue | null;

interface CollectionRangeValue {
  from: CollectionRangeBound;
  to: CollectionRangeBound;
}

export type CollectionValue =
  | CollectionScalar
  | CollectionDynamicValue
  | CollectionRelativeValue
  | CollectionMoneyValue
  | CollectionRangeValue
  | (CollectionScalar | CollectionDynamicValue)[];

export interface CollectionCondition {
  field: string;
  op: CollectionOperator;
  value?: CollectionValue | undefined;
  /** Source scope for fields every source reports separately. */
  source?: string | undefined;
}

/** Conditions combined with AND (`all`) or OR (`any`). */
export interface CollectionWhere {
  match: 'all' | 'any';
  conditions: CollectionCondition[];
}

/** A grouping request: a field, and a calendar granularity for dates. */
export interface CollectionGrouping {
  field: string;
  granularity?: CollectionGranularity | undefined;
}

/** Group key as returned to clients: enum value, ID, local date (`YYYY-MM-DD`), boolean or null. */
export type CollectionGroupKey = string | number | boolean | null;

/** One group of a grouped list read. */
export interface CollectionGroupResult {
  key: CollectionGroupKey;
  /** Matching records in the group over the full filtered set, not only the returned rows. */
  count: number;
  /** False when the list knows its source data may be missing records. */
  complete: boolean;
  /** The group's first rows in sort order. */
  itemIds: string[];
  /** Continues within this group with the same query plus `groupKey`. */
  nextCursor: string | null;
  /** Per-currency sums of money fields over records with a reported amount. */
  sums: { field: string; currency: string | null; amount: string }[];
}

/** Conditions, grouping and calendar settings a configurable list query accepts. */
export interface CollectionListParameters {
  /** Catalog conditions, validated against the list catalog by the API layer. */
  where?: CollectionWhere | undefined;
  /** Groups rows; each group carries its count and first `groupLimit` rows. */
  group?: CollectionGrouping | undefined;
  /** Reads one group's rows, paged by `cursor` and `limit`, instead of every group. */
  groupKey?: CollectionGroupKey | undefined;
  /** Rows per group when grouping without `groupKey`, 1 to 50 (10 by default). */
  groupLimit?: number | undefined;
  /** IANA zone for relative dates, `today` and date groups; UTC by default. */
  timeZone?: string | undefined;
}

/** The grouping part of a list read. */
export interface CollectionGroupedResult {
  /** Present when grouping: groups in display order, or the one group `groupKey` named. */
  groups?: CollectionGroupResult[];
  /** True when more groups match than the list returns. */
  groupsTruncated?: boolean;
}
