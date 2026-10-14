import type { TenantContext } from '@luma/identity';
import type { RefundState, ReturnStage, StageGroup } from '@luma/orders';

import type {
  CollectionGroupedResult,
  CollectionListParameters,
} from './collections.js';

export type { ReturnStage };

/** `action` needs a person; `waiting` is with the customer or payment provider; `done` is final. */
export type ReturnView = StageGroup | 'all';

type ReturnStatus =
  'requested' | 'open' | 'closed' | 'declined' | 'cancelled' | 'unknown';

type Money = {
  amount: string;
  currency: string;
};

/** Refund payment totals. Only `refunded` is money returned to the customer. */
type ReturnRefund = {
  state: RefundState;
  currency: string | null;
  refunded: string | null;
  pending: string | null;
  failedAttempts: number;
};

/** A return, or a refund without a return, as the source last reported it. */
export type ReturnListItem = {
  id: string;
  kind: 'return' | 'refund';
  connectionId: string;
  externalId: string | null;
  name: string | null;
  order: { id: string; displayNumber: string | null };
  status: ReturnStatus | null;
  stage: ReturnStage;
  group: StageGroup;
  refund: ReturnRefund;
  quantity: string | null;
  received: string | null;
  refundedUnits: string | null;
  value: Money | null;
  reasons: string[];
  requestedAt: string | null;
  /** Latest source event: request, approval, receipt, refund, payment or close. */
  activityAt: string;
  observedAt: string;
  sourceUpdatedAt: string | null;
  deleted: boolean;
};

/** A commerce connection and whether it shares returns with Luma. */
export type ReturnSource = {
  connectionId: string;
  label: string;
  system: string | null;
  appId: string | null;
  status: string;
  /** `not_requested`: the connection was set up without returns, or its source cannot share them. */
  access: 'granted' | 'not_granted' | 'not_requested';
  records: number;
  importing: boolean;
  /** When a full read of returns last completed; null means absence is not established. */
  fullReadAt: string | null;
  lastReadAt: string | null;
  failing: boolean;
};

/** Stages in lifecycle order, as the list sorts and groups them. */
export const returnLifecycle = [
  'requested',
  'awaiting_items',
  'awaiting_refund',
  'refund_pending',
  'refund_failed',
  'ready_to_close',
  'refunded',
  'refund_recorded',
  'closed',
  'declined',
  'cancelled',
  'unknown',
] as const satisfies readonly ReturnStage[];

/** Refund states in the order the list groups them. */
export const returnRefundStates = [
  'none',
  'recorded',
  'pending',
  'failed',
  'partial',
  'refunded',
] as const satisfies readonly RefundState[];

/**
 * List parameters. Conditions and groups follow the Returns catalog and also narrow the
 * per-view and per-stage counts. Search also matches the name and email address of the
 * order's customer when the reader can read customers.
 */
export interface ReturnQuery extends CollectionListParameters {
  q: string;
  view: ReturnView;
  stage?: ReturnStage | undefined;
  connectionId?: string | undefined;
  /**
   * `value` and `pendingRefund` order by currency, then amount. `stage` follows the lifecycle.
   * Returns without a value come last in both directions.
   */
  sort: 'requested' | 'activity' | 'value' | 'pendingRefund' | 'stage';
  direction: 'asc' | 'desc';
  count?: 'exact' | undefined;
  cursor?: string | undefined;
  /** Page size, 1 to 50. */
  limit: number;
}

interface ReturnList extends CollectionGroupedResult {
  items: ReturnListItem[];
  sources: ReturnSource[];
  /** Matches per view and per stage for the search, filters and conditions; every key is present. */
  counts: {
    views: Record<ReturnView, number>;
    stages: Record<ReturnStage, number>;
  };
  nextCursor: string | null;
  asOf: string;
}

export interface ReturnDetail {
  item: ReturnListItem;
  source: ReturnSource | null;
  order: {
    id: string;
    displayNumber: string | null;
    externalId: string | null;
    status: string;
    paymentStatus: string;
    placedAt: string | null;
    total: Money | null;
  } | null;
  lines: {
    orderLineId: string | null;
    title: string | null;
    skuId: string | null;
    skuCode: string | null;
    quantity: string;
    unit: string;
    reason: string | null;
    received: string | null;
    restocked: string | null;
    refunded: string | null;
    value: Money | null;
  }[];
  timeline: {
    requestedAt: string | null;
    approvedAt: string | null;
    receivedAt: string | null;
    closedAt: string | null;
    declineReason: 'return_period_ended' | 'final_sale' | 'other' | null;
  };
  refunds: {
    id: string;
    externalId: string | null;
    createdAt: string | null;
    total: Money | null;
    lines: {
      orderLineId: string;
      title: string | null;
      quantity: string;
      unit: string;
      restock: 'return' | 'cancel' | 'no_restock' | 'unknown';
      restocked: boolean;
    }[];
    transactions: {
      status: 'success' | 'pending' | 'failed' | 'unknown';
      amount: Money;
      processedAt: string | null;
      gateway: string | null;
    }[];
    observedAt: string;
    sourceUpdatedAt: string | null;
  }[];
  /** Other returns and refunds of the same order. */
  related: ReturnListItem[];
  history: {
    entries: {
      snapshotId: string;
      entityKind: 'return' | 'refund';
      entityId: string;
      status: string | null;
      current: boolean;
      deleted: boolean;
      observedAt: string;
      sourceUpdatedAt: string | null;
    }[];
    truncated: boolean;
  };
  /** `order` is null and listed here when the reader can't read orders. */
  hidden: 'order'[];
  asOf: string;
}

/**
 * Reads imported returns and refunds with their order context. Stage and refund state come from
 * the orders owner; no source is asked to change anything. Requires `returns.read`; the order
 * context also needs `orders.read`.
 */
export interface ReturnWorkspace {
  /** Rejects a cursor produced by other filters or sorting with a 400 error. */
  list(context: TenantContext, query: ReturnQuery): Promise<ReturnList>;
  /**
   * Returns a return, or a refund without a return, or null when the tenant has none with this
   * ID. A refund that settles a return resolves to that return.
   */
  get(context: TenantContext, id: string): Promise<ReturnDetail | null>;
}
