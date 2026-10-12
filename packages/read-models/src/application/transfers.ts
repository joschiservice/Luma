import type { TenantContext } from '@luma/identity';
import type {
  ReceivingSignal,
  ShipmentData,
  TransferData,
  TransferFacts,
  TransferLocation,
} from '@luma/inventory';

export interface TransferQuery {
  kind: 'inventory_transfer' | 'inventory_shipment';
  q: string;
  connectionId?: string | undefined;
  skuId?: string | undefined;
  locationId?: string | undefined;
  cursor?: string | undefined;
}

export interface TransferSummary {
  id: string;
  connectionId: string;
  label: string;
  kind: TransferQuery['kind'];
  name: string;
  status: string;
  snapshotId: string;
  observedAt: string;
  facts: TransferFacts;
  evidence: 'fresh' | 'stale' | 'incomplete' | 'unavailable' | 'removed';
  signals: ReceivingSignal[];
}

export interface TransferDetail {
  record: TransferSummary;
  data: TransferData | ShipmentData | null;
  provenance: {
    observationId: string;
    sourceRevision: string | null;
    sourceUpdatedAt: string | null;
  };
  deleted: boolean;
  source: { externalId: string; scopeKey: string } | null;
  shipments: TransferSummary[];
  transfers: TransferSummary[];
  history: {
    name: string;
    snapshotId: string;
    observedAt: string;
    deleted: boolean;
    status: string;
    receivedQuantity: string | null;
    origin: TransferLocation | null;
    destination: TransferLocation | null;
  }[];
  purchaseOrders: { id: string; label: string; status: string }[];
  hidden: 'purchaseOrders'[];
  relatedTruncated: boolean;
  asOf: string;
}

/** Reads bounded source transfer and receiving evidence without modifying stock or making claims. */
export interface TransferWorkspace {
  /** Returns at most 50 summaries with a cursor scoped to the tenant and filters. */
  listTransfers(
    context: TenantContext,
    query: TransferQuery,
  ): Promise<{
    items: TransferSummary[];
    nextCursor: string | null;
    asOf: string;
  }>;
  /** Reads one source projection and only explicit shipment and procurement relationships. */
  getTransfer(
    context: TenantContext,
    id: string,
    connectionId: string,
  ): Promise<TransferDetail | null>;
}
