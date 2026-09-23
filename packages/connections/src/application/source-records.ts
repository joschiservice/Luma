import type { TenantContext } from '@luma/identity';

import type {
  FulfillmentSnapshot,
  InventorySnapshot,
  Observation,
  OrderSnapshot,
  SourceIdentity,
} from '../domain/capabilities.js';

export type CommerceObservation =
  | { capability: 'orders.read'; observation: Observation<OrderSnapshot> }
  | {
      capability: 'inventory.read';
      observation: Observation<InventorySnapshot>;
    }
  | {
      capability: 'fulfillment.read';
      observation: Observation<FulfillmentSnapshot>;
    };

export interface SourceRecords {
  /** Stores an observation idempotently; an ingest key reused for different content is rejected. */
  record(
    context: TenantContext,
    ingestKey: string,
    input: CommerceObservation,
  ): Promise<CommerceObservation>;
  /** Reads a previously stored observation from this tenant, or null when absent. */
  get(
    context: TenantContext,
    connectionId: string,
    ingestKey: string,
  ): Promise<CommerceObservation | null>;
  /** Records an evidence-backed mapping to an existing canonical entity; requires an owner or admin. */
  bind(
    context: TenantContext,
    source: SourceIdentity,
    canonicalId: string,
    observationId: string,
    method: string,
  ): Promise<void>;
  /** Returns the current canonical mapping for this source, or null when none exists. */
  resolve(
    context: TenantContext,
    source: SourceIdentity,
  ): Promise<string | null>;
}
