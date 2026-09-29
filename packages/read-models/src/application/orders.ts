import type { TenantContext } from '@luma/identity';

/** Fulfillment across an order's lines, from shipped, delivered or completed work of the same source. */
export type FulfillmentState =
  'unfulfilled' | 'partial' | 'fulfilled' | 'not_required' | 'no_lines';

/** A compared field whose known values disagree between current sources; null is unknown. */
export interface OrderDifference {
  field: 'status' | 'paymentStatus' | 'total' | 'lines';
  values: { connectionId: string; value: string | null }[];
}

export type OrderView =
  'all' | 'outstanding' | 'overdue' | 'needs_you' | 'differs';

export type OrderSort = 'updated' | 'placed' | 'number' | 'due';

export interface OrderListQuery {
  q: string;
  view: OrderView;
  status?: string | undefined;
  paymentStatus?: string | undefined;
  connectionId?: string | undefined;
  placedFrom?: string | undefined;
  placedBefore?: string | undefined;
  updatedFrom?: string | undefined;
  updatedBefore?: string | undefined;
  sort: OrderSort;
  direction: 'asc' | 'desc';
  limit: number;
  cursor?: string | undefined;
}

export interface Money {
  amount: string;
  currency: string;
}

export interface OrderSource {
  connectionId: string;
  label: string;
  system: string | null;
  connectionStatus: string;
  externalId: string | null;
  selected: boolean;
  deleted: boolean;
  observedAt: string;
  sourceUpdatedAt: string | null;
}

export interface OrderListItem {
  id: string;
  displayNumber: string | null;
  placedAt: string | null;
  total: Money | null;
  status: string;
  paymentStatus: string;
  fulfillment: FulfillmentState;
  lineCount: number;
  open: boolean | null;
  overdue: boolean | null;
  dueAt: string | null;
  /** Unresolved issues on this order that currently need a person. */
  issueIds: string[];
  differs: boolean;
  sources: OrderSource[];
  observedAt: string;
  sourceUpdatedAt: string | null;
}

export interface OrderList {
  items: OrderListItem[];
  totalCount: number;
  nextCursor: string | null;
  asOf: string;
}

export interface OrderSourceFacts extends OrderSource {
  appId: string | null;
  mappingMethod: string | null;
  displayNumber: string | null;
  status: string;
  paymentStatus: string;
  placedAt: string | null;
  total: Money | null;
  dueAt: string | null;
  fulfillment: FulfillmentState;
  open: boolean | null;
  lines: {
    id: string;
    skuId: string | null;
    skuCode: string | null;
    title: string | null;
    quantity: string;
    cancelledQuantity: string | null;
    unit: string;
    fulfilledQuantity: string;
    remainingQuantity: string | null;
  }[];
}

export interface OrderDetail {
  order: OrderListItem;
  sources: OrderSourceFacts[];
  differences: OrderDifference[];
  fulfillments: {
    id: string;
    connectionId: string;
    externalId: string | null;
    status: string;
    lastProgressAt: string | null;
    failureCode: string | null;
    deleted: boolean;
    observedAt: string;
    sourceUpdatedAt: string | null;
    lines: { orderLineId: string; quantity: string; unit: string }[];
  }[];
  issues: {
    id: string;
    class: string;
    state: string;
    severity: string | null;
    relationship: 'order' | 'fulfillment' | 'sku';
    needsYou: boolean;
    lastDetectedAt: string | null;
  }[];
  workflows: {
    id: string;
    definitionId: string;
    name: string | null;
    version: string;
    createdAt: string | null;
    state: string;
    relationship: 'order' | 'issue';
  }[];
  history: {
    entries: {
      snapshotId: string;
      entityKind: 'order' | 'fulfillment';
      entityId: string;
      connectionId: string;
      status: string;
      paymentStatus: string | null;
      deleted: boolean;
      current: boolean;
      observedAt: string;
      sourceUpdatedAt: string | null;
    }[];
    truncated: boolean;
  };
  activity: {
    entries: OrderActivityEntry[];
    truncated: boolean;
  };
  asOf: string;
}

export interface OrderActivityEntry {
  id: string;
  recordedAt: string;
  action: string;
  type: string;
  outcome: string;
  actorKind: string | null;
  exceptionId: string | null;
  summary: string | null;
}

/**
 * Reads workspace activity linked to an order's issues, workflow runs or order references,
 * applying the same visibility rules as the Activity page.
 */
export interface OrderActivityReader {
  list(
    context: TenantContext,
    query: {
      from: string;
      to: string;
      limit: number;
      subjects: { issueIds: string[]; runIds: string[]; orderRefs: string[] };
    },
  ): Promise<{ items: OrderActivityEntry[]; nextCursor: string | null }>;
}

/** Reads current orders for one tenant from canonical projections and linked Luma records. */
export interface OrderWorkspace {
  /** Rejects a cursor produced by different filters or sorting with a 400 error. */
  list(context: TenantContext, query: OrderListQuery): Promise<OrderList>;
  get(context: TenantContext, orderId: string): Promise<OrderDetail | null>;
}
