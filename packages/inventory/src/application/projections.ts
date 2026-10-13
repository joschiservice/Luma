import type { TenantContext } from '@luma/identity';

import type { ShipmentData, TransferData } from '../domain/transfers.js';

export type {
  TransferData,
  ShipmentData,
  TransferLocation,
} from '../domain/transfers.js';

type EntityKind =
  | 'sku'
  | 'location'
  | 'product'
  | 'position'
  | 'inventory_transfer'
  | 'inventory_shipment';

type CommerceData =
  | TransferData
  | ShipmentData
  | {
      type: 'position';
      composition?: {
        variant: { externalId: string; scopeKey: string };
        requiresComponents: boolean;
        hasComponents: boolean;
      } | null;
      skuId: string;
      locationId: string;
      unit: string;
      onHand: string | null;
      reserved: string | null;
      available: string | null;
      committed?: string | null;
      incoming?: string | null;
      damaged?: string | null;
      qualityControl?: string | null;
      safetyStock?: string | null;
      locationActive?: boolean | null;
      itemActive?: boolean | null;
      tracked?: boolean | null;
      /** Versioned quantity meaning; absent for earlier or other provider reports. */
      inventorySemantics?: 'shopify/1' | null;
      /** Corroborates a known provider adjustment without attributing the whole stock report to it. */
      writeAttribution?: {
        evidenceId: string;
        adjustmentId: string;
        referenceDocumentUri: string;
        available: string;
        quantityMatches: boolean | null;
      } | null;
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
        /** Exact recipe metadata; parent merchandising does not add a physical stock balance. */
        bundle?: {
          variant: { externalId: string; scopeKey: string };
          requiresComponents: boolean;
          components:
            | {
                sourceId: { externalId: string; scopeKey: string };
                sourceVariant: { externalId: string; scopeKey: string };
                sourceSku: { externalId: string; scopeKey: string } | null;
                skuId: string | null;
                quantity: string;
              }[]
            | null;
        };
      }[];
    };

/** A current source projection that refers to a SKU or location. */
export type Dependent = {
  entityId: string;
  kind: 'position' | 'product' | 'inventory_transfer' | 'inventory_shipment';
  connectionId: string;
  observationId: string;
};

export interface CanonicalSnapshot {
  /** Version 2 adds product/stock facts; position version 3 adds corroborated write attribution. */
  schemaVersion: 1 | 2 | 3 | 4;
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

interface Projection {
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
   * Projects snapshots in input order in one transaction, holding every affected entity's lock.
   * Any failure rejects the batch.
   */
  projectMany(
    context: TenantContext,
    snapshots: CanonicalSnapshot[],
  ): Promise<('applied' | 'retained' | 'duplicate')[]>;
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
   * entity. Snapshots remain as history and the removal is recorded; requires
   * `sync.manage`. Returns false when no projection existed.
   */
  retire(
    context: TenantContext,
    entityId: string,
    connectionId: string,
    reason: string,
  ): Promise<boolean>;
}
