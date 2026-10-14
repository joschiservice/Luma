import { canonicalJson } from '@luma/platform';

import type { OrderProgress, OrderStage } from '../domain/commitments.js';
import type { Amount } from '../domain/order-value.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import { listQueryError } from './list-conditions.js';

// Structural mirror of the collection query contract (`@luma/api-contract` collections). The
// API layer validates requests against the list catalog; the application only sees these shapes.

export type ListOperator =
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

type ListScalar = string | number | boolean;

/** Resolved at read time: `today` is the reader's local day. */
interface ListDynamicValue {
  dynamic: 'me' | 'today';
}

/** A period of whole local days, weeks or months relative to the read time. */
export interface ListRelativeValue {
  amount: number;
  unit: 'day' | 'week' | 'month';
}

export type ListRangeBound = ListScalar | Amount | ListDynamicValue | null;

export type ListValue =
  | ListScalar
  | ListDynamicValue
  | ListRelativeValue
  | Amount
  | { from: ListRangeBound; to: ListRangeBound }
  | (ListScalar | ListDynamicValue)[];

export interface ListCondition {
  field: string;
  op: ListOperator;
  value?: ListValue | undefined;
  source?: string | undefined;
}

/** Conditions combined with AND (`all`) or OR (`any`). */
export interface ListWhere {
  match: 'all' | 'any';
  conditions: ListCondition[];
}

/** A grouping request; lists here group by fields without calendar periods. */
interface ListGrouping {
  field: string;
  granularity?: 'day' | 'week' | 'month' | undefined;
}

/** A group key as clients receive it: an option, a record ID or null for rows without a value. */
export type ListGroupKey = string | number | boolean | null;

/** One group of a grouped list read. */
export interface ListGroup {
  key: ListGroupKey;
  /** Every match in the group, not only the returned rows. */
  count: number;
  complete: boolean;
  /** The group's first rows in the list's sort. */
  itemIds: string[];
  /** Continues within this group with the same query plus `groupKey`. */
  nextCursor: string | null;
  /** Per-currency sums of money fields over rows with a known amount. */
  sums: { field: string; currency: string | null; amount: string }[];
}

/** A bound of a date range: an ISO 8601 instant, or a calendar day for day fields. */
export interface StoredBound {
  at: string;
  inclusive: boolean;
}

/** A number comparison; `value` is a decimal as text. */
export interface StoredComparison {
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string;
}

/**
 * A condition the store applies in SQL, already resolved: IDs and option values, literal text,
 * number comparisons (all must hold), or a date range in which days and relative periods were
 * resolved in the reader's zone.
 */
export type StoredCondition = { field: string } & (
  | { op: 'any_of' | 'none_of' | 'all_of'; values: string[] }
  | { op: 'empty' | 'not_empty' }
  | { op: 'contains' | 'not_contains' | 'is' | 'is_not'; text: string }
  | { op: 'flag'; value: boolean }
  | { op: 'compare'; comparisons: StoredComparison[] }
  | { op: 'range'; from: StoredBound | null; to: StoredBound | null }
);

/** Custom field types, as the workspace's field definitions name them. */
export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'single_choice'
  | 'multi_choice'
  | 'person';

/** A live custom field the reader may read, which a list filters or sorts by. */
export interface ListCustomField {
  id: string;
  type: CustomFieldType;
}

/** A sort by a custom field, `custom:<field ID>`. */
export type CustomSort = `custom:${string}`;

/** Stored conditions combined with AND (`all`) or OR (`any`). */
export interface StoredWhere {
  match: 'all' | 'any';
  conditions: StoredCondition[];
}

export type PurchaseOrderSort =
  | 'created'
  | 'updated'
  | 'expected'
  | 'reference'
  | 'supplier'
  | 'confirmationDue'
  | 'nextCheck'
  | 'value'
  | CustomSort;

/** Sorts the store reads in SQL order; the others are derived and sorted in memory. */
export type StoredPurchaseOrderSort = Extract<
  PurchaseOrderSort,
  'created' | 'updated' | 'reference' | 'supplier' | CustomSort
>;

/** Search, supplier and status filters that the store evaluates. */
export interface PurchaseOrderFilter {
  /** Matches the reference, supplier name or a line SKU, ignoring case. */
  q: string;
  supplierId?: string | undefined;
  status?: PurchaseOrder['status'] | undefined;
  /** Only these orders. */
  ids?: string[] | undefined;
  /** Catalog conditions on stored fields. */
  conditions?: StoredWhere | undefined;
  /** Custom fields that conditions (`custom:<ID>`) or the sort name. */
  customFields?: ListCustomField[] | undefined;
}

export interface PurchaseOrderListQuery extends Omit<
  PurchaseOrderFilter,
  'ids' | 'conditions' | 'customFields'
> {
  /** A derived stage, or `attention`: at least one item needs an answer beyond a send approval. */
  stage?: OrderStage | 'attention' | undefined;
  /** Catalog conditions, validated against the procurement catalog by the API layer. */
  where?: ListWhere | undefined;
  /** Groups rows; each group carries its exact count and first `groupLimit` rows. */
  group?: ListGrouping | undefined;
  /** Reads one group's rows, paged by `cursor` and `limit`, instead of every group. */
  groupKey?: ListGroupKey | undefined;
  /** Rows returned per group when reading every group, from 1 to 50; defaults to 10. */
  groupLimit?: number | undefined;
  /** IANA zone for days and relative periods in conditions; defaults to UTC. */
  timeZone?: string | undefined;
  sort: PurchaseOrderSort;
  /** Defaults to descending for `created` and `updated`, ascending otherwise. */
  direction?: 'asc' | 'desc' | undefined;
  /** Page size from 1 to 50. */
  limit: number;
  count?: 'exact' | undefined;
  cursor?: string | undefined;
}

/** An order's progress in lists: stage, expected date, open attention and next owner. */
export interface OrderSummary {
  id: string;
  stage: OrderStage;
  expectedDate: string | null;
  /** Open attention items beyond a pending send approval, which shows in the stage. */
  attention: number;
  /** Kinds of those items, each once, in their order of urgency. */
  attentionKinds: OrderProgress['attention'][number]['kind'][];
  overdue: boolean;
  nextOwner: OrderProgress['next']['owner'];
  externalOrderNumber: string | null;
  confirmationDueAt: string | null;
  nextCheckAt: string | null;
  /** Sum of quantity × unit price; see `orderValue`. */
  value: Amount | null | 'unknown';
}

export interface PurchaseOrderList {
  items: (PurchaseOrder & { summary: OrderSummary })[];
  canManage: boolean;
  /** Null unless the query asked for an exact count. */
  totalCount: number | null;
  /** Workspace counts, returned with an unfiltered first page only. */
  counts: {
    all: number;
    attention: number;
    stages: Partial<Record<OrderStage, number>>;
  } | null;
  nextCursor: string | null;
  /** With `group`: every group in display order. With `groupKey`: the one group read. */
  groups?: ListGroup[] | undefined;
  /** More than 50 groups match. */
  groupsTruncated?: boolean | undefined;
  asOf: string;
}

export type SupplierSort = 'name' | 'created' | 'orders' | CustomSort;

export interface SupplierListQuery {
  /** Matches the name or an external reference system or ID, ignoring case. */
  q: string;
  /** Catalog conditions, validated against the suppliers catalog by the API layer. */
  where?: ListWhere | undefined;
  /** IANA zone for days and relative periods in conditions; defaults to UTC. */
  timeZone?: string | undefined;
  sort: SupplierSort;
  /** Defaults to ascending for `name`, descending otherwise. */
  direction?: 'asc' | 'desc' | undefined;
  /** Page size from 1 to 50. */
  limit: number;
  count?: 'exact' | undefined;
  cursor?: string | undefined;
}

/**
 * Position after the last row of a page. `rank` 1 marks a row without a sort value; those
 * follow all others in both directions. `keys` hold the sort values as PostgreSQL text.
 */
export interface ListPosition {
  rank: 0 | 1;
  keys: string[] | null;
  id: string;
}

/** A store row with its position in the requested order. */
export interface Positioned<T> {
  record: T;
  position: ListPosition;
}

export type SupplierRow = Positioned<Supplier & { orderCount: number }>;

/** Supplier search and conditions that the store evaluates. */
export interface SupplierFilter {
  q: string;
  conditions?: StoredWhere | undefined;
  /**
   * Suppliers with an open `confirmation_overdue` item, for the `confirmationOverdue` field.
   * Required when a condition names it.
   */
  confirmationOverdue?: string[] | undefined;
  /** Custom fields that conditions (`custom:<ID>`) or the sort name. */
  customFields?: ListCustomField[] | undefined;
}

/** The direction of a purchase-order sort when the query names none. */
export const purchaseOrderDirection = (
  query: Pick<PurchaseOrderListQuery, 'sort' | 'direction'>,
) =>
  query.direction ??
  (query.sort === 'created' || query.sort === 'updated' ? 'desc' : 'asc');

/** The direction of a supplier sort when the query names none. */
export const supplierDirection = (
  query: Pick<SupplierListQuery, 'sort' | 'direction'>,
) => query.direction ?? (query.sort === 'name' ? 'asc' : 'desc');

/** The reader's IANA zone for days and relative periods; UTC when the query names none. */
export function listTimeZone(timeZone: string | undefined) {
  const zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw listQueryError('Use an IANA time zone, such as Europe/Berlin.');
  }

  return zone;
}

/**
 * Identifies one list query for its cursors: the tenant and every parameter that decides which
 * rows match and in which order. Property order and undefined properties do not matter;
 * `version` changes when the cursor format or the meaning of parameters changes.
 */
export function listScope(
  digest: (value: unknown) => string,
  version: string,
  tenantId: string,
  query: Record<string, unknown>,
) {
  const plain: unknown = JSON.parse(JSON.stringify(query));

  return digest([version, tenantId, canonicalJson(plain)]);
}

/** Encodes the position after `last`; `asOf` keeps the evaluation time of the first page. */
export function writeListCursor(
  context: string,
  last: ListPosition,
  asOf?: string,
) {
  return Buffer.from(
    JSON.stringify({ context, ...last, ...(asOf ? { asOf } : {}) }),
  ).toString('base64url');
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Decodes a cursor issued for the query identified by `context`. Throws a 400 error naming
 * `noun` when the cursor is malformed, lacks a required evaluation time or belongs to other
 * filters or sorting.
 */
export function readListCursor(
  value: string,
  context: string,
  noun: string,
  requireAsOf = false,
): ListPosition & { asOf?: string } {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Encoding');
    const cursor: unknown = JSON.parse(bytes.toString());
    if (typeof cursor !== 'object' || cursor === null) throw new Error('Shape');
    const {
      context: scope,
      rank,
      keys,
      id,
      asOf,
    } = cursor as Record<string, unknown>;
    if (scope !== context) throw new Error('Context');
    if (rank !== 0 && rank !== 1) throw new Error('Rank');
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Id');
    if (
      keys !== null &&
      !(
        Array.isArray(keys) &&
        keys.length <= 2 &&
        keys.every((key) => typeof key === 'string' && key.length <= 1024)
      )
    )
      throw new Error('Keys');
    if (rank === 0 && keys === null) throw new Error('Keys');
    if (
      (requireAsOf && asOf === undefined) ||
      (asOf !== undefined &&
        (typeof asOf !== 'string' || isNaN(Date.parse(asOf))))
    )
      throw new Error('As of');

    return {
      rank,
      keys: keys as string[] | null,
      id,
      ...(typeof asOf === 'string' ? { asOf } : {}),
    };
  } catch {
    throw Object.assign(
      new Error(
        `This page link no longer matches the ${noun} filters. Start from the first page.`,
      ),
      { statusCode: 400, expose: true },
    );
  }
}

/** Compares the sort keys at `index` of two positions: negative, zero or positive. */
export type KeyComparator = (a: string, b: string, index: number) => number;

const plainKeys: KeyComparator = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compares two positions in list order: rows without a value last, then keys and ID in
 * `direction`. Keys compare as plain strings, such as ISO dates, unless `compareKeys` compares
 * them by type, such as amounts.
 */
export function comparePositions(
  a: ListPosition,
  b: ListPosition,
  direction: 'asc' | 'desc',
  compareKeys: KeyComparator = plainKeys,
) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const sign = direction === 'asc' ? 1 : -1;
  const left = a.keys ?? [];
  const right = b.keys ?? [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? -sign : sign;
      continue;
    }
    const order = x === y ? 0 : compareKeys(x, y, index);
    if (order) return order * sign;
  }

  return a.id === b.id ? 0 : a.id < b.id ? -sign : sign;
}
