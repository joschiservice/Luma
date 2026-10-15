import type { FactAuthority } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type {
  ComparisonDifference,
  ComparisonState,
  OrderChangePlan,
  OrderChangeRequest,
  OrderCommercialData,
  OrderJourney,
  OrderLineCommercialData,
} from '@luma/orders';
import type { ActivityActor } from '@luma/resolution';

import type {
  CollectionGrouping,
  CollectionGroupKey,
  CollectionGroupResult,
  CollectionWhere,
} from './collections.js';
import type { ReturnListItem } from './returns.js';

/** Order statuses in the order lists show and group them. */
export const orderStatuses = [
  'open',
  'completed',
  'cancelled',
  'unknown',
] as const;

/** Payment statuses in the order lists show and group them. */
export const orderPaymentStatuses = [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'unknown',
] as const;

/** Fulfillment states in the order lists show and group them. */
export const orderFulfillmentStates = [
  'unfulfilled',
  'partial',
  'fulfilled',
  'not_required',
  'no_lines',
] as const;

/** Source comparison states in the order lists show and group them. */
export const orderComparisonStates = [
  'matching',
  'pending',
  'confirmed',
  'inconclusive',
] as const;

/** Fulfillment across an order's lines, from shipped, delivered or completed work of the same source. */
type FulfillmentState = (typeof orderFulfillmentStates)[number];

/** A source disagreement with immutable evidence and the current workspace authority. */
export interface OrderDifference extends ComparisonDifference {
  authority: FactAuthority | null;
}

export type OrderView =
  'all' | 'outstanding' | 'overdue' | 'needs_you' | 'differs' | 'stuck';

export type OrderSort =
  | 'updated'
  | 'placed'
  | 'number'
  | 'due'
  | 'total'
  | 'status'
  | 'paymentStatus'
  | 'fulfillment'
  | 'lineCount';

/** Internal saved-view constraints; record owners authorize every referenced field. */
export interface OrderAdaptiveSelection {
  filters: {
    fieldId: string;
    operator:
      'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_empty';
    value: string | number | boolean | null;
  }[];
  sort?: { fieldId: string; direction: 'asc' | 'desc' } | undefined;
  selectedRecordIds?: readonly string[] | undefined;
  offset?: number | undefined;
}

export interface OrderListQuery {
  adaptive?: OrderAdaptiveSelection | undefined;
  q: string;
  locationId?: string | undefined;
  stockBlocked?: true | undefined;
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
  /**
   * Catalog conditions (validated against the Orders catalog by the caller). Warehouse needs
   * `fulfillment.read`, stock-blocked also `inventory.read`, customer `customers.read`.
   */
  where?: CollectionWhere | undefined;
  /** Groups rows; each group carries its count and first `groupLimit` rows. */
  group?: CollectionGrouping | undefined;
  /** Reads one group's rows, paged by `cursor` and `limit`, instead of every group. */
  groupKey?: CollectionGroupKey | undefined;
  /** Rows per group when grouping without `groupKey`. */
  groupLimit?: number | undefined;
  /** IANA zone for relative dates, `today` and date groups. */
  timeZone?: string | undefined;
  /** A native sort, or `custom:<field ID>` for a readable single-value custom field. */
  sort: OrderSort | `custom:${string}`;
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
  /** Commercial facts of the selected source; absent while order projections rebuild. */
  channel?: string | null;
  tags?: string[];
  test?: boolean | null;
}

export interface OrderList {
  items: OrderListItem[];
  totalCount: number | null;
  nextCursor: string | null;
  /** Present when grouping: groups in display order, or the one group `groupKey` named. */
  groups?: CollectionGroupResult[];
  /** True when more groups match than the list returns. */
  groupsTruncated?: boolean;
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
  /** Partial shipping views only report matched items; missing lines are unreported. */
  lineCoverage?: 'complete' | 'partial';
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
    bundleGroup?: {
      id: { externalId: string; scopeKey: string };
      title: string;
      quantity: string;
      product: { externalId: string; scopeKey: string } | null;
      variant: { externalId: string; scopeKey: string } | null;
      skuCode: string | null;
    } | null;
    comparisonKey: string | null;
    unitPrice?: { amount: string; currency: string } | null;
    /**
     * Current units × the unit price after discounts, or `unitPrice` when the source reports no
     * discounted price; null when either is not reported.
     */
    currentTotal?: { amount: string; currency: string } | null;
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
  journey?: OrderJourney;
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
 * Plans for one order: the proposed change, or every change the source comparison found.
 * `hidden` lists `fulfillments` when the reader can't see fulfilment, which makes every plan's
 * safety unknown.
 */
export interface OrderChangePlans {
  orderId: string;
  comparisonState: ComparisonState;
  plans: OrderChangePlan[];
  hidden: 'fulfillments'[];
  asOf: string;
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
  /**
   * Plans a proposed change, or the detected ones, from the same snapshot rules as `get`.
   * Rejects a line that is not on the order with a 422 error.
   */
  changePlan(
    context: TenantContext,
    orderId: string,
    request: OrderChangeRequest | null,
  ): Promise<OrderChangePlans | null>;
}
