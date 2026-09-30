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
        quantity: string;
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
      lines: { orderLineId: string; quantity: string; unit: string }[];
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
   * Document schema version. Order snapshots are written as 2 and may carry `dueAt`,
   * `placedAt`, `total` and line `skuCode`/`title`. Fulfillment snapshots are written as 2
   * and may carry kind, holds, location, dates, method, tracking and delivery state. Stored
   * version 1 documents of both kinds remain readable. Return and refund snapshots use 1.
   */
  schemaVersion: 1 | 2;
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
  has(context: TenantContext, kind: EntityKind, id: string): Promise<boolean>;
  project(
    context: TenantContext,
    snapshot: CanonicalSnapshot,
  ): Promise<'applied' | 'retained' | 'duplicate'>;
  current(context: TenantContext, entityId: string): Promise<Projection[]>;
  history(
    context: TenantContext,
    entityId: string,
  ): Promise<CanonicalSnapshot[]>;
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
