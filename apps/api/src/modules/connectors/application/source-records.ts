import type { TenantContext } from '#modules/identity/index';
import type {
  Observation,
  OrderSnapshot,
  InventorySnapshot,
  FulfillmentSnapshot,
  SourceIdentity,
} from '#modules/connectors/domain/capabilities';
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
  record(
    context: TenantContext,
    ingestKey: string,
    input: CommerceObservation,
  ): Promise<CommerceObservation>;
  get(
    context: TenantContext,
    connectionId: string,
    ingestKey: string,
  ): Promise<CommerceObservation | null>;
  bind(
    context: TenantContext,
    source: SourceIdentity,
    canonicalId: string,
    observationId: string,
    method: string,
  ): Promise<void>;
  resolve(
    context: TenantContext,
    source: SourceIdentity,
  ): Promise<string | null>;
}
