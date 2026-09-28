import type { TenantContext } from '@luma/identity';

export type EntityKind = 'order' | 'order_line' | 'fulfillment';

export type CommerceData =
  | {
      type: 'order';
      displayNumber: string | null;
      /** Source-provided fulfillment deadline; absent means unknown. */
      dueAt?: string | null;
      status: string;
      paymentStatus: string;
      lines: {
        id: string;
        skuId: string | null;
        quantity: string;
        cancelledQuantity: string | null;
        unit: string;
      }[];
    }
  | {
      type: 'fulfillment';
      orderId: string;
      status: string;
      lastProgressAt: string | null;
      failureCode: string | null;
      lines: { orderLineId: string; quantity: string; unit: string }[];
    };

export interface CanonicalSnapshot {
  schemaVersion: 1;
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
}
