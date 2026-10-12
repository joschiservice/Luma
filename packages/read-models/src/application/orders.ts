import type { FactAuthority } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type {
  ComparisonDifference,
  ComparisonState,
  OrderCommercialData,
  OrderLineCommercialData,
} from '@luma/orders';
import type { ActivityActor } from '@luma/resolution';

import type { ReturnListItem } from './returns.js';

/** Fulfillment across an order's lines, from shipped, delivered or completed work of the same source. */
type FulfillmentState =
  'unfulfilled' | 'partial' | 'fulfilled' | 'not_required' | 'no_lines';

/** A source disagreement with immutable evidence and the current workspace authority. */
export interface OrderDifference extends ComparisonDifference {
  authority: FactAuthority | null;
}

export type OrderView =
  'all' | 'outstanding' | 'overdue' | 'needs_you' | 'differs';

export type OrderSort = 'updated' | 'placed' | 'number' | 'due';

export interface OrderListQuery {
  q: string;
  /** Request an exact total; omitted counts return null and avoid counting every match. */
  count?: 'exact' | undefined;
  view: OrderView;
  status?: string | undefined;
  paymentStatus?: string | undefined;
  connectionId?: string | undefined;
  /**
   * Imported customer profile ID: only orders whose source reports this customer as the
   * buyer. Requires `customers.read`.
   */
  customerId?: string | undefined;
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
  comparisonState: ComparisonState;
  sources: OrderSource[];
  observedAt: string;
  sourceUpdatedAt: string | null;
}

export interface OrderList {
  items: OrderListItem[];
  totalCount: number | null;
  nextCursor: string | null;
  asOf: string;
}

/** A postal address as the source reported it. Protected customer data. */
export interface OrderAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * The addresses one source reported for an order. `shared` carries them, null when the order
 * has none; `not_shared` means the deployment is not approved to read addresses; `not_imported`
 * means no read has recorded addresses for this source.
 */
export type OrderSourceAddresses =
  | {
      state: 'shared';
      shipping: OrderAddress | null;
      billing: OrderAddress | null;
      observedAt: string;
    }
  | { state: 'not_shared'; observedAt: string }
  | { state: 'not_imported' };

/**
 * One source's report of an order. Commercial facts are absent when the source does not report
 * them; see `OrderCommercialData`.
 */
export interface OrderSourceFacts extends OrderSource, OrderCommercialData {
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
  /** Absent when the reader can't read customers; the detail then lists `addresses` as hidden. */
  addresses?: OrderSourceAddresses;
  lines: ({
    id: string;
    skuId: string | null;
    comparisonKey: string | null;
    unitPrice?: { amount: string; currency: string } | null;
    /** Whether `unitPrice` includes tax, as the source states it; null when unknown. */
    taxIncluded?: boolean | null;
    taxRate?: string | null;
    skuCode: string | null;
    title: string | null;
    quantity: string;
    currentQuantity: string | null;
    cancelledQuantity: string | null;
    unit: string;
    fulfilledQuantity: string;
    remainingQuantity: string | null;
  } & OrderLineCommercialData)[];
}

/**
 * Order detail sections that need another area's read permission. Order addresses need
 * permission to read customers.
 */
export type OrderDetailSection =
  | 'fulfillments'
  | 'returns'
  | 'issues'
  | 'workflows'
  | 'activity'
  | 'addresses';

export interface OrderDetail {
  /** Live source authority and resolved facts; null means no authoritative source report. */
  authority: {
    revision: number;
    groups: FactAuthority[];
    lines: {
      connectionId: string;
      lines: Omit<
        OrderSourceFacts['lines'][number],
        'fulfilledQuantity' | 'remainingQuantity' | 'cancelledQuantity'
      >[];
    } | null;
    lifecycle: {
      connectionId: string;
      status: string;
      cancelledQuantities: {
        lineId: string;
        quantity: string | null;
        unit: string;
      }[];
    } | null;
    fulfillments: OrderDetail['fulfillments'] | null;
    tracking:
      | {
          fulfillmentId: string;
          connectionId: string;
          tracking:
            | {
                carrier: string | null;
                number: string | null;
                url: string | null;
              }[]
            | null;
        }[]
      | null;
  };
  /** Retired URL identity, when this read resolved to the current order. */
  redirectedFrom?: string | null;
  order: OrderListItem;
  sources: OrderSourceFacts[];
  differences: OrderDifference[];
  fulfillments: {
    id: string;
    connectionId: string;
    externalId: string | null;
    status: string;
    /** Source record kind distinguishes fulfillment work from shipments when reported. */
    kind?: string | null;
    lastProgressAt: string | null;
    failureCode: string | null;
    deleted: boolean;
    observedAt: string;
    sourceUpdatedAt: string | null;
    location: { locationId: string | null; name: string | null } | null;
    /** Null distinguishes unread tracking from a reported empty list. */
    tracking:
      | { carrier: string | null; number: string | null; url: string | null }[]
      | null;
    lines: {
      orderLineId: string;
      quantity: string;
      unit: string;
      remainingQuantity: string | null;
    }[];
  }[];
  /** Returns, and refunds without a return, from every source of the order. */
  returns: ReturnListItem[];
  issues: {
    id: string;
    class: string;
    state: string;
    severity: string | null;
    relationship: 'order' | 'fulfillment' | 'sku';
    needsYou: boolean;
    lastDetectedAt: string | null;
    /** Resolved issues of this class about the same record that this latest one stands for. */
    occurrences: number;
  }[];
  /** Ordered SKUs with a stock gap Luma is letting provider sync close. */
  stockSync: { skuId: string; since: string; until: string }[];
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
      entityKind: 'order' | 'fulfillment' | 'return' | 'refund';
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
  /**
   * Sections left empty because the reader can't read their area. Fulfillment, return and
   * refund history entries follow their section.
   */
  hidden: OrderDetailSection[];
  asOf: string;
}

interface OrderActivityEntry {
  id: string;
  recordedAt: string;
  action: string;
  type: string;
  outcome: string;
  actor: ActivityActor;
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

/**
 * Reads current orders for one tenant from canonical projections and linked Luma records.
 * Requires `orders.read`. Issue links need `issues.read`; detail sections of other areas need
 * their read permission and are listed in `hidden` otherwise.
 */
export interface OrderWorkspace {
  /** Rejects a cursor produced by different filters or sorting with a 400 error. */
  list(context: TenantContext, query: OrderListQuery): Promise<OrderList>;
  get(context: TenantContext, orderId: string): Promise<OrderDetail | null>;
}
