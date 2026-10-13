import type { TenantContext } from '@luma/identity';

import type { RefundData, ReturnData } from '../domain/returns.js';

export type { RefundData, ReturnData } from '../domain/returns.js';

type EntityKind = 'order' | 'order_line' | 'fulfillment' | 'return' | 'refund';

type Money = { amount: string; currency: string };

/** An amount in the shop currency and in the currency the customer was charged in. */
export type MoneyPair = { shop: Money; presentment: Money };

/** An amount as originally placed and as it stands after edits, refunds and returns. */
type OrderAmount = { original: MoneyPair | null; current: MoneyPair | null };

/**
 * Commercial facts of order schema version 6, as the source reported them. Absent groups were
 * not read; null values were read but not reported. Amounts are never recomputed.
 */
export interface OrderCommercialData {
  currencies?: { shop: string | null; presentment: string | null };
  amounts?: Record<
    'subtotal' | 'shipping' | 'discounts' | 'tax' | 'duties' | 'total',
    OrderAmount
  >;
  taxesIncluded?: boolean | null;
  dutiesIncluded?: boolean | null;
  taxLines?: {
    title: string | null;
    rate: string | null;
    amount: MoneyPair | null;
  }[];
  shippingLines?: {
    /** Source shipping line ID; descriptive, not a canonical identity. */
    id: string | null;
    title: string | null;
    code: string | null;
    source: string | null;
    carrier: string | null;
    removed: boolean | null;
    original: MoneyPair | null;
    discounted: MoneyPair | null;
    current: MoneyPair | null;
  }[];
  discounts?: {
    index: number | null;
    kind: 'code' | 'automatic' | 'manual' | 'script' | 'unknown';
    label: string | null;
    target: 'line_item' | 'shipping_line' | 'unknown';
    allocation: 'across' | 'each' | 'unknown';
    value:
      | { type: 'percentage'; percentage: string }
      | { type: 'fixed'; amount: Money }
      | null;
  }[];
  tags?: string[];
  attributes?: {
    edited: boolean | null;
    requiresShipping: boolean | null;
    test: boolean | null;
    cancelReason: string | null;
    cancelledAt: string | null;
    closedAt: string | null;
    processedAt: string | null;
    channel: string | null;
    /** The source's own fulfillment status label, not Luma's fulfillment state. */
    fulfillmentStatus: string | null;
  };
}

/** Line facts of order schema version 6; absent when the source does not report them. */
export interface OrderLineCommercialData {
  variantTitle?: string | null;
  prices?: {
    originalUnit: MoneyPair | null;
    /** Unit price after line and order discounts. */
    discountedUnit: MoneyPair | null;
    totalDiscount: MoneyPair | null;
  };
  requiresShipping?: boolean | null;
  /**
   * Whether the line's variant still exists at the source: `variant_removed` when only its
   * product remains, `no_product` for a custom item or a deleted product.
   */
  catalog?: 'variant' | 'variant_removed' | 'no_product';
}

export type CommerceData =
  | ({
      type: 'order';
      displayNumber: string | null;
      /** Source-provided fulfillment deadline; absent means unknown. */
      dueAt?: string | null;
      /** When the order was placed at the source; absent means the adapter did not read it. */
      placedAt?: string | null;
      /** Source-reported total including tax; absent or null means unknown. */
      total?: { amount: string; currency: string } | null;
      status: string;
      paymentStatus: string;
      lines: ({
        id: string;
        skuId: string | null;
        /** Originally ordered units, retained after reductions. */
        quantity: string;
        /** Current units excluding removals and refunds; absent or null when unknown. */
        currentQuantity?: string | null;
        cancelledQuantity: string | null;
        unit: string;
        unitPrice?: { amount: string; currency: string } | null;
        /** Whether the source's unit price includes tax, or unknown. */
        taxIncluded?: boolean | null;
        /** Fractional source tax rate, or unknown. */
        taxRate?: string | null;
        /** Source SKU text. Descriptive only; `skuId` carries the mapped identity. */
        skuCode?: string | null;
        title?: string | null;
        /** Exact source merchandising group; it never creates a second stock or fulfillment quantity. */
        bundleGroup?: {
          id: { externalId: string; scopeKey: string };
          title: string;
          quantity: string;
          product: { externalId: string; scopeKey: string } | null;
          variant: { externalId: string; scopeKey: string } | null;
          skuCode: string | null;
        } | null;
      } & OrderLineCommercialData)[];
    } & OrderCommercialData)
  | {
      type: 'fulfillment';
      orderId: string;
      status: string;
      /** Exact milestone times reported by the source; absence means unknown. */
      milestones?: {
        pickedAt?: string | null;
        shippedAt?: string | null;
        deliveredAt?: string | null;
      };
      lastProgressAt: string | null;
      failureCode: string | null;
      lines: {
        orderLineId: string;
        quantity: string;
        unit: string;
        /** Provider-reported outstanding work; absent or null when unknown. */
        remainingQuantity?: string | null;
      }[];
      /** Fulfillment work or a shipment; absent means the adapter did not say. */
      kind?: 'fulfillment_order' | 'shipment' | null;
      /** Holds stopping the work; absent means the adapter does not read holds. */
      holds?: { reason: string }[];
      /** Assigned or shipping location; `locationId` is null when the source location is unmapped. */
      location?: { locationId: string | null; name: string | null } | null;
      fulfillAt?: string | null;
      fulfillBy?: string | null;
      estimatedDeliveryAt?: string | null;
      method?: { type: string; name: string | null } | null;
      tracking?: {
        carrier: string | null;
        number: string | null;
        url: string | null;
      }[];
      delivery?: string | null;
    }
  | ReturnData
  | RefundData;

export interface CanonicalSnapshot {
  /**
   * Order snapshots use version 7 for sold bundle groups, version 6 for commercial facts,
   * version 5 for whether unit prices include tax, and version 4 for optional unit prices
   * and fractional tax rates.
   * Fulfillment version 4 adds explicit milestone times.
   * Order and fulfillment snapshots use version 3 for current and remaining line quantities.
   * Stored versions 1 and 2 remain readable. Return and refund snapshots use version 1.
   */
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  entityId: string;
  kind: EntityKind;
  connectionId: string;
  observationId: string;
  normalizerVersion: string;
  mappingVersion: string;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
  deleted: boolean;
  data: CommerceData;
}

export interface Projection {
  snapshotId: string;
  version: number;
  snapshot: CanonicalSnapshot;
}

export interface CommerceProjections {
  identify(
    context: TenantContext,
    kind: EntityKind,
    reconciliationKey: string,
  ): Promise<string>;
  /**
   * Creates or finds entities for many reconciliation keys in one sorted write. The result maps
   * `JSON.stringify([kind, reconciliationKey])` to the entity ID.
   */
  identifyMany(
    context: TenantContext,
    items: { kind: EntityKind; reconciliationKey: string }[],
  ): Promise<Map<string, string>>;
  /** Returns the IDs that are not entities of this kind in the tenant. */
  missing(
    context: TenantContext,
    kind: EntityKind,
    ids: string[],
  ): Promise<string[]>;
  project(
    context: TenantContext,
    snapshot: CanonicalSnapshot,
  ): Promise<'applied' | 'retained' | 'duplicate'>;
  /**
   * Projects snapshots in input order in one transaction, holding every affected order's lock
   * and refreshing the order, fulfillment and return lists once. Any failure rejects the batch.
   */
  projectMany(
    context: TenantContext,
    snapshots: CanonicalSnapshot[],
  ): Promise<('applied' | 'retained' | 'duplicate')[]>;
  current(context: TenantContext, entityId: string): Promise<Projection[]>;
  /** Current projections of many entities in one read, keyed by entity ID; absent when none. */
  currentMany(
    context: TenantContext,
    entityIds: string[],
  ): Promise<Map<string, Projection[]>>;
  history(
    context: TenantContext,
    entityId: string,
  ): Promise<CanonicalSnapshot[]>;
  /** Reads an existing immutable child-parent binding, or null for a new child. */
  childParent(context: TenantContext, childId: string): Promise<string | null>;
  /** Current order and child observations, parent first, for replay after an order link. */
  orderDependents(
    context: TenantContext,
    orderId: string,
    connectionId?: string,
  ): Promise<
    { entityId: string; connectionId: string; observationId: string }[]
  >;
  /** Retires one source pointer, keeps its snapshots, and redirects retired identities. */
  retire(
    context: TenantContext,
    entityId: string,
    connectionId: string,
    targetId: string,
    reason: string,
  ): Promise<boolean>;
  /**
   * Lists current order projections with a line mapped to this SKU, optionally limited to one
   * connection. Re-project them after the SKU's mappings change.
   */
  skuDependents(
    context: TenantContext,
    skuId: string,
    connectionId?: string,
  ): Promise<
    { entityId: string; connectionId: string; observationId: string }[]
  >;
  /**
   * Lists current fulfillment projections assigned to this location, optionally limited to
   * one connection. Re-project them after the location's mappings change.
   */
  locationDependents(
    context: TenantContext,
    locationId: string,
    connectionId?: string,
  ): Promise<
    { entityId: string; connectionId: string; observationId: string }[]
  >;
}
