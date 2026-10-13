import type { TenantContext } from '@luma/identity';

import type { OrderDetail } from './orders.js';

export type FulfillmentView =
  'attention' | 'held' | 'delayed' | 'open' | 'in_transit' | 'all';

export type FulfillmentSignal =
  | 'held'
  | 'overdue'
  | 'stalled'
  | 'delivery_issue'
  | 'late_delivery'
  | 'failed';

type FulfillmentSort = 'waiting' | 'recent' | 'deadline';

type Tracking = {
  carrier: string | null;
  number: string | null;
  url: string | null;
};

/** One source's current report of a fulfillment order or shipment. */
export interface FulfillmentItem {
  id: string;
  connectionId: string;
  externalId: string | null;
  kind: 'fulfillment_order' | 'shipment' | 'unknown';
  status: string;
  deleted: boolean;
  open: boolean;
  signals: FulfillmentSignal[];
  /** Null when the source does not report holds. */
  holds: string[] | null;
  location: { id: string | null; name: string | null } | null;
  method: { type: string; name: string | null } | null;
  fulfillAt: string | null;
  fulfillBy: string | null;
  estimatedDeliveryAt: string | null;
  lastProgressAt: string | null;
  progressAt: string;
  delivery: string | null;
  failureCode: string | null;
  tracking: Tracking[];
  /** Provider-reported handoff; unavailable and ambiguous possession remain explicit. */
  shipping?: {
    stage: 'merchant' | 'warehouse' | 'carrier' | 'delivered' | 'unknown';
    sourceUrl: string | null;
    trackingUpdatedAt: string | null;
  } | null;
  units: string;
  unit: string | null;
  order: {
    id: string;
    number: string | null;
    status: string | null;
    placedAt: string | null;
  };
  observedAt: string;
  sourceUpdatedAt: string | null;
}

export interface FulfillmentSource {
  connectionId: string;
  label: string;
  system: string | null;
  status: string;
  appId: string | null;
}

export interface FulfillmentQuery {
  q: string;
  view: FulfillmentView;
  connectionId?: string | undefined;
  locationId?: string | undefined;
  kind?: 'fulfillment_order' | 'shipment' | undefined;
  sort: FulfillmentSort;
  cursor?: string | undefined;
  /** Page size, 1 to 50; defaults to 50. */
  limit?: number | undefined;
}

interface FulfillmentList {
  items: FulfillmentItem[];
  sources: FulfillmentSource[];
  locations: { id: string; name: string | null; open: number }[];
  counts: Record<FulfillmentView, number>;
  nextCursor: string | null;
  stalledAfterHours: number;
  asOf: string;
}

/** Fulfillment detail sections that need another area's read permission. */
export type FulfillmentDetailSection = 'issues' | 'workflows' | 'activity';

export interface FulfillmentDetail {
  item: FulfillmentItem;
  source: FulfillmentSource;
  lines: {
    orderLineId: string;
    quantity: string;
    unit: string;
    skuId: string | null;
    skuCode: string | null;
    title: string | null;
    ordered: string | null;
  }[];
  order: {
    id: string;
    number: string | null;
    status: string | null;
    paymentStatus: string | null;
    placedAt: string | null;
    externalId: string | null;
    fulfillment: string | null;
  };
  related: FulfillmentItem[];
  timeline: {
    entries: {
      snapshotId: string;
      current: boolean;
      deleted: boolean;
      observedAt: string;
      sourceUpdatedAt: string | null;
      status: string;
      holds: string[] | null;
      delivery: string | null;
      shipping?: FulfillmentItem['shipping'];
      lastProgressAt: string | null;
      locationName: string | null;
      fulfillBy: string | null;
    }[];
    truncated: boolean;
  };
  issues: OrderDetail['issues'];
  workflows: (OrderDetail['workflows'][number] & {
    purpose: 'method_correction' | 'other';
    progressObservedAt: string | null;
  })[];
  activity: OrderDetail['activity'];
  /** Sections left empty because the reader can't read their area. */
  hidden: FulfillmentDetailSection[];
  stalledAfterHours: number;
  asOf: string;
}

/**
 * Reads fulfillment work and shipments from each source's current projection, classifying
 * holds, delays and failures without merging mirrored work across sources. Requires
 * `fulfillment.read`; detail sections of other areas need their read permission.
 */
export interface FulfillmentWorkspace {
  /** Returns up to `limit` fulfillments. A cursor must belong to the same tenant and filters. */
  list(
    context: TenantContext,
    query: FulfillmentQuery,
  ): Promise<FulfillmentList>;
  /** Returns one fulfillment with its evidence and linked work, or null when unknown. */
  get(
    context: TenantContext,
    fulfillmentId: string,
  ): Promise<FulfillmentDetail | null>;
}
