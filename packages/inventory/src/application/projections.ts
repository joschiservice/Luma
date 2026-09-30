import type { TenantContext } from '@luma/identity';

export type EntityKind = 'sku' | 'location' | 'product' | 'position';

export type CommerceData =
  | {
      type: 'position';
      skuId: string;
      locationId: string;
      unit: string;
      onHand: string | null;
      reserved: string | null;
      available: string | null;
      availabilityBasis: 'provider_reported' | 'derived' | 'unknown';
    }
  | {
      type: 'product';
      title: string | null;
      status: 'active' | 'draft' | 'archived' | 'unknown';
      /** Brand or manufacturer text; descriptive only. Absent in version 1 documents. */
      vendor?: string | null;
      /** Whether the source offers the product on its own sales channel. */
      published?: boolean | null;
      /** Variants as canonical SKUs. `code` is source text and never establishes identity. */
      skus: {
        skuId: string;
        code: string | null;
        unit: string;
        title?: string | null;
        /** Source list price; a null currency means the source did not report one. */
        price?: { amount: string; currency: string | null } | null;
        barcode?: string | null;
      }[];
    };

/** A current source projection that refers to a SKU or location. */
export type Dependent = {
  entityId: string;
  kind: 'position' | 'product';
  connectionId: string;
  observationId: string;
};

export interface CanonicalSnapshot {
  /** Product snapshots use version 2 since they may carry listing and price facts. */
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
   * Lists current source projections whose data refers to this SKU or location, optionally
   * limited to one connection. Re-project them after the entity's mappings change.
   */
  dependents(
    context: TenantContext,
    kind: 'sku' | 'location',
    id: string,
    connectionId?: string,
  ): Promise<Dependent[]>;
  /**
   * Removes one source's current projection of an entity after that source moved to another
   * entity. Snapshots remain as history and the removal is recorded; requires an owner or
   * admin. Returns false when no projection existed.
   */
  retire(
    context: TenantContext,
    entityId: string,
    connectionId: string,
    reason: string,
  ): Promise<boolean>;
}
