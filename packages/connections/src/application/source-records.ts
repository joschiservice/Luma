import type { TenantContext } from '@luma/identity';

import type {
  FulfillmentSnapshot,
  InventoryShipmentSnapshot,
  InventorySnapshot,
  InventoryTransferSnapshot,
  Observation,
  OrderSnapshot,
  ProductSnapshot,
  RefundSnapshot,
  ReturnSnapshot,
  SourceIdentity,
} from '../domain/capabilities.js';

export type CommerceObservation =
  | {
      capability: 'inventory.transfers.read';
      observation: Observation<InventoryTransferSnapshot>;
    }
  | {
      capability: 'inventory.shipments.read';
      observation: Observation<InventoryShipmentSnapshot>;
    }
  | { capability: 'orders.read'; observation: Observation<OrderSnapshot> }
  | {
      capability: 'inventory.read';
      observation: Observation<InventorySnapshot>;
    }
  | {
      capability: 'fulfillment.read';
      observation: Observation<FulfillmentSnapshot>;
    }
  | { capability: 'products.read'; observation: Observation<ProductSnapshot> }
  | {
      capability: 'returns.read';
      observation: Observation<ReturnSnapshot | RefundSnapshot>;
    };

/** A source identity's current mapping, with the evidence that established it. */
export interface SourceMapping {
  source: SourceIdentity;
  canonicalId: string;
  method: string;
  actorId: string;
  createdAt: string;
  /** Latest remapping, when the source was moved from another canonical entity. */
  revisedAt: string | null;
  /** Immutable identity of the latest remapping, used to re-key order children. */
  revisionId: string | null;
  /** The prior canonical identity of the latest remapping, for guarded child re-keying. */
  previousCanonicalId: string | null;
}

export interface SourceRecords {
  /** Stores an observation idempotently; an ingest key reused for different content is rejected. */
  record(
    context: TenantContext,
    ingestKey: string,
    input: CommerceObservation,
  ): Promise<CommerceObservation>;
  /**
   * Stores observations in one transaction and returns them in input order. Any invalid
   * observation, unavailable connection or conflicting ingest key rejects the batch.
   */
  recordMany(
    context: TenantContext,
    items: { ingestKey: string; input: CommerceObservation }[],
  ): Promise<CommerceObservation[]>;
  /** Reads a previously stored observation from this tenant, or null when absent. */
  get(
    context: TenantContext,
    connectionId: string,
    ingestKey: string,
  ): Promise<CommerceObservation | null>;
  /** Records an evidence-backed mapping to an existing canonical entity; requires `sync.manage`. */
  bind(
    context: TenantContext,
    source: SourceIdentity,
    canonicalId: string,
    observationId: string,
    method: string,
  ): Promise<void>;
  /**
   * Records many evidence-backed mappings in one sorted write; requires `sync.manage`.
   * A source already mapped elsewhere, missing evidence or a missing target rejects the batch.
   */
  bindMany(
    context: TenantContext,
    entries: {
      source: SourceIdentity;
      canonicalId: string;
      observationId: string;
      method: string;
    }[],
  ): Promise<void>;
  /** Returns the current canonical mapping for this source, or null when none exists. */
  resolve(
    context: TenantContext,
    source: SourceIdentity,
  ): Promise<string | null>;
  /**
   * Resolves many identities in one read. The result maps
   * `JSON.stringify([connectionId, resource, scopeKey, externalId])` to the canonical ID and
   * omits unmapped identities.
   */
  resolveMany(
    context: TenantContext,
    sources: SourceIdentity[],
  ): Promise<Map<string, string>>;
  /** Reads a stored observation by ID in this tenant and connection, or null when absent. */
  observation(
    context: TenantContext,
    connectionId: string,
    observationId: string,
  ): Promise<CommerceObservation | null>;
  /** Returns the canonical IDs, among those given, with a source mapping that was ever revised. */
  revised(
    context: TenantContext,
    resource: SourceIdentity['resource'],
    canonicalIds: string[],
  ): Promise<Set<string>>;
  /** Lists the source identities currently mapped to one canonical entity. */
  mappings(
    context: TenantContext,
    resource: SourceIdentity['resource'],
    canonicalId: string,
  ): Promise<SourceMapping[]>;
  /**
   * Moves a source mapping from `from` to `to` and appends a revision with the actor, method and
   * reason; requires `sync.manage`. Returns false without changes when the source no
   * longer maps to `from`. Callers must re-project affected snapshots afterwards.
   */
  remap(
    context: TenantContext,
    source: SourceIdentity,
    from: string,
    to: string,
    method: string,
    reason: string,
  ): Promise<boolean>;
}
