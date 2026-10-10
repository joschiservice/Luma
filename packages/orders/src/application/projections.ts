import type { TenantContext } from '@luma/identity';

import type { RefundData, ReturnData } from '../domain/returns.js';

export type {
  CanonicalMoney,
  RefundData,
  ReturnData,
} from '../domain/returns.js';

export type EntityKind =
  'order' | 'order_line' | 'fulfillment' | 'return' | 'refund';

export type CommerceData =
  | {
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
      lines: {
        id: string;
        skuId: string | null;
        /** Originally ordered units, retained after reductions. */
        quantity: string;
        /** Current units excluding removals and refunds; absent or null when unknown. */
        currentQuantity?: string | null;
        cancelledQuantity: string | null;
        unit: string;
        /** Source SKU text. Descriptive only; `skuId` carries the mapped identity. */
        skuCode?: string | null;
        title?: string | null;
      }[];
    }
  | {
      type: 'fulfillment';
      orderId: string;
      status: string;
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
   * Order and fulfillment snapshots use version 3 for current and remaining line quantities.
   * Stored versions 1 and 2 remain readable. Return and refund snapshots use version 1.
   */
  schemaVersion: 1 | 2 | 3;
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
