import type { OrderStage } from '../domain/commitments.js';
import {
  addDecimals,
  type Amount,
  compareDecimals,
  type Decimal,
  formatDecimal,
  parseDecimal,
} from '../domain/order-value.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { isCustomSort } from './custom-fields.js';
import {
  type ListFields,
  listQueryError,
  unknownValue,
} from './list-conditions.js';
import type {
  KeyComparator,
  ListGroup,
  ListGroupKey,
  ListOperator,
  ListPosition,
  OrderSummary,
  PurchaseOrderSort,
  StoredPurchaseOrderSort,
} from './lists.js';

/** A purchase order with its list summary, evaluated at the list's read time. */
export interface PurchaseOrderRow {
  order: PurchaseOrder;
  summary: OrderSummary;
}

/** A row with its position in the requested order. */
export interface PositionedRow extends PurchaseOrderRow {
  position: ListPosition;
}

const text = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const choice = [
  'any_of',
  'none_of',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const quantity = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];
const moment = [
  'before',
  'after',
  'between',
  'within_last',
  'within_next',
  'empty',
  'not_empty',
] as const satisfies readonly ListOperator[];

/** Stages in pipeline order, as lists show and group them. */
export const purchaseOrderStages = [
  'draft',
  'awaiting_approval',
  'sending',
  'send_failed',
  'awaiting_confirmation',
  'confirmed',
  'changed',
  'partially_received',
  'received',
  'closed',
  'cancelled',
] as const satisfies readonly OrderStage[];

/** Attention kinds lists filter by; a pending send approval shows in the stage instead. */
export const listedAttentionKinds = [
  'submission_uncertain',
  'submission_failed',
  'review_commitment',
  'commitment_changed',
  'confirmation_overdue',
  'delivery_overdue',
  'receipt_difference',
] as const satisfies readonly OrderSummary['attentionKinds'][number][];

export const purchaseOrderStatuses = [
  'draft',
  'open',
  'closed',
  'cancelled',
] as const satisfies readonly PurchaseOrder['status'][];

export const nextOwners = [
  'buyer',
  'approver',
  'supplier',
  'warehouse',
  'luma',
  'none',
] as const satisfies readonly OrderSummary['nextOwner'][];

export const purchaseOrderAuthorities = [
  'luma',
  'external',
] as const satisfies readonly PurchaseOrder['authority'][];

/**
 * Purchase-order list fields. Stored fields filter in SQL when the plan allows it; stage,
 * attention, next owner and the progress dates come from the progress rules at the list's read
 * time, and value from the order lines, so they filter in memory.
 */
export const purchaseOrderFields: ListFields<PurchaseOrderRow> = {
  reference: {
    kind: 'text',
    operators: text,
    stored: text,
    read: (row) => row.order.reference,
  },
  supplier: {
    kind: 'choice',
    ids: true,
    operators: ['any_of', 'none_of'],
    stored: ['any_of', 'none_of'],
    read: (row) => row.order.supplierId,
  },
  status: {
    kind: 'choice',
    operators: choice,
    stored: choice,
    read: (row) => row.order.status,
  },
  authority: {
    kind: 'choice',
    operators: choice,
    stored: choice,
    read: (row) => row.order.authority,
  },
  stage: {
    kind: 'choice',
    operators: ['any_of', 'none_of'],
    read: (row) => row.summary.stage,
  },
  attention: {
    kind: 'choices',
    operators: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'],
    read: (row) => row.summary.attentionKinds,
  },
  nextOwner: {
    kind: 'choice',
    operators: choice,
    read: (row) => row.summary.nextOwner,
  },
  expected: {
    kind: 'day',
    operators: moment,
    read: (row) => row.summary.expectedDate,
  },
  confirmationDue: {
    kind: 'instant',
    operators: moment,
    read: (row) => row.summary.confirmationDueAt,
  },
  nextCheck: {
    kind: 'instant',
    operators: moment,
    read: (row) => row.summary.nextCheckAt,
  },
  created: {
    kind: 'instant',
    operators: moment,
    stored: moment,
    read: (row) => row.order.createdAt,
  },
  updated: {
    kind: 'instant',
    operators: moment,
    stored: moment,
    read: (row) => row.order.updatedAt,
  },
  lines: {
    kind: 'number',
    operators: quantity,
    read: (row) => row.order.lines.length,
  },
  location: {
    kind: 'choices',
    ids: true,
    operators: choice,
    stored: choice,
    read: (row) => [
      ...new Set(
        row.order.lines.flatMap((line) =>
          line.locationId ? [line.locationId] : [],
        ),
      ),
    ],
  },
  sku: {
    kind: 'texts',
    operators: ['contains', 'not_contains', 'is', 'is_not'],
    stored: ['contains', 'not_contains', 'is', 'is_not'],
    read: (row) => row.order.lines.map((line) => line.sku),
  },
  value: {
    kind: 'money',
    operators: [...quantity, 'unknown'],
    read: (row) =>
      row.summary.value === 'unknown' ? unknownValue : row.summary.value,
  },
};

/** Whether the store orders rows by this sort in SQL, as it does for custom fields. */
export function isStoredSort(
  sort: PurchaseOrderSort,
): sort is StoredPurchaseOrderSort {
  return (
    sort === 'created' ||
    sort === 'updated' ||
    sort === 'reference' ||
    sort === 'supplier' ||
    isCustomSort(sort)
  );
}

function amountKeys(value: Amount | null | 'unknown') {
  return value && value !== 'unknown' ? [value.currency, value.amount] : null;
}

/** The position of a row for a sort evaluated in memory; rows without a value rank last. */
export function derivedPosition(
  row: PurchaseOrderRow,
  sort: Exclude<PurchaseOrderSort, StoredPurchaseOrderSort>,
): ListPosition {
  const { summary } = row;
  const keys =
    sort === 'value'
      ? amountKeys(summary.value)
      : [
          sort === 'expected'
            ? summary.expectedDate
            : sort === 'confirmationDue'
              ? summary.confirmationDueAt &&
                new Date(summary.confirmationDueAt).toISOString()
              : summary.nextCheckAt,
        ].flatMap((key) => (key ? [key] : []));

  return keys?.length
    ? { rank: 0, keys, id: row.order.id }
    : { rank: 1, keys: null, id: row.order.id };
}

function decimalKey(text: string): Decimal {
  const parsed = parseDecimal(text);
  if (!parsed)
    throw listQueryError(
      'This page link no longer matches the purchase order filters. Start from the first page.',
    );

  return parsed;
}

/**
 * Compares derived sort keys by type: `value` orders by currency code, then amount numerically,
 * so amounts are only ranked within their currency. Dates are normalized ISO text.
 */
export function derivedKeyComparator(sort: PurchaseOrderSort): KeyComparator {
  return (a, b, index) =>
    sort === 'value' && index === 1
      ? compareDecimals(decimalKey(a), decimalKey(b))
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;
}

interface GroupField {
  key: (row: PurchaseOrderRow) => string | null;
  /** Option order, or `supplier`: by supplier name, then ID. */
  order: readonly string[] | 'supplier';
  ids?: true;
}

const groupFields: Readonly<Record<string, GroupField>> = {
  supplier: {
    key: (row) => row.order.supplierId,
    order: 'supplier',
    ids: true,
  },
  status: { key: (row) => row.order.status, order: purchaseOrderStatuses },
  stage: { key: (row) => row.summary.stage, order: purchaseOrderStages },
  nextOwner: { key: (row) => row.summary.nextOwner, order: nextOwners },
  authority: {
    key: (row) => row.order.authority,
    order: purchaseOrderAuthorities,
  },
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The grouping field, or a 400 error when the list cannot group by it. */
export function purchaseOrderGroupField(
  field: string,
  granularity?: string,
): GroupField {
  const group = Object.hasOwn(groupFields, field)
    ? groupFields[field]
    : undefined;
  if (!group) throw listQueryError('This field cannot be grouped.');
  if (granularity) throw listQueryError('Only dates group by period.');

  return group;
}

/**
 * Selects the rows of one group for paging within it. Throws a 400 error when the key cannot
 * belong to the field, such as a number for a stage.
 */
export function groupMember(
  group: GroupField,
  key: ListGroupKey,
): (row: PurchaseOrderRow) => boolean {
  if (key !== null && typeof key !== 'string')
    throw listQueryError('This group does not exist.');
  if (key !== null && group.ids && !uuid.test(key))
    throw listQueryError('This group does not exist.');
  const wanted = key !== null && group.ids ? key.toLowerCase() : key;

  return (row) => {
    const value = group.key(row);

    return (
      (value !== null && group.ids ? value.toLowerCase() : value) === wanted
    );
  };
}

/** Per-currency sums of known order values. */
function valueSums(rows: PurchaseOrderRow[]): ListGroup['sums'] {
  const sums = new Map<string, Decimal>();
  for (const { summary } of rows) {
    if (!summary.value || summary.value === 'unknown') continue;
    const amount = parseDecimal(summary.value.amount);
    if (!amount) continue;
    const prior = sums.get(summary.value.currency);
    sums.set(
      summary.value.currency,
      prior ? addDecimals(prior, amount) : amount,
    );
  }

  return [...sums]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({
      field: 'value',
      currency,
      amount: formatDecimal(amount),
    }));
}

/** Groups returned at most; `groupsTruncated` says when more match. */
export const maxGroups = 50;

/**
 * Groups every matching row, given in the list's sort. Groups follow the field's option order,
 * suppliers sort by name (ignoring case) then ID, and rows without a value form the last group.
 * Each group keeps its exact count, its first `limit` rows and, when more exist, a cursor from
 * `cursor` positioned after its last returned row. Returns at most 50 groups.
 */
export function groupPurchaseOrders(
  rows: PositionedRow[],
  group: GroupField,
  limit: number,
  cursor: (key: ListGroupKey, last: ListPosition) => string,
): { groups: ListGroup[]; truncated: boolean; items: PositionedRow[] } {
  const members = new Map<string | null, PositionedRow[]>();
  for (const row of rows) {
    const key = group.key(row);
    const list = members.get(key) ?? [];
    list.push(row);
    members.set(key, list);
  }
  const names = new Map<string, string>();
  if (group.order === 'supplier')
    for (const [key, list] of members)
      if (key !== null)
        names.set(
          key,
          list.map((row) => row.order.supplierName.toLowerCase()).sort()[0] ??
            '',
        );
  const rank = (key: string) => {
    if (group.order === 'supplier') return 0;
    const index = group.order.indexOf(key);

    return index < 0 ? group.order.length : index;
  };
  const ordered = [...members.keys()].sort((a, b) => {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    const nameA = names.get(a) ?? '';
    const nameB = names.get(b) ?? '';
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;

    return a < b ? -1 : a > b ? 1 : 0;
  });
  const items: PositionedRow[] = [];
  const groups = ordered.slice(0, maxGroups).map((key): ListGroup => {
    const list = members.get(key) ?? [];
    const head = list.slice(0, limit);
    const last = head.at(-1);
    items.push(...head);

    return {
      key,
      count: list.length,
      complete: true,
      itemIds: head.map((row) => row.order.id),
      nextCursor:
        last && list.length > head.length ? cursor(key, last.position) : null,
      sums: valueSums(list),
    };
  });

  return { groups, truncated: ordered.length > maxGroups, items };
}
