import type { TenantContext } from '#modules/identity/index';

export type EntityKind = 'sku' | 'location' | 'product' | 'position';

export type CommerceData = {
  type: 'position';
  skuId: string;
  locationId: string;
  unit: string;
  onHand: string | null;
  reserved: string | null;
  available: string | null;
  availabilityBasis: 'provider_reported' | 'derived' | 'unknown';
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
