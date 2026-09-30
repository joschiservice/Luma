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
    }
  | ReturnData
  | RefundData;

export interface CanonicalSnapshot {
  /**
   * Document schema version. Order snapshots are written as 2 and may carry `dueAt`,
   * `placedAt`, `total` and line `skuCode`/`title`; stored version 1 order documents
   * remain readable. Fulfillment, return and refund snapshots use 1.
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
}
