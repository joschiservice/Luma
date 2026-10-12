import type { TenantContext } from '@luma/identity';

import type {
  AccountAddress,
  LedgerAccount,
  PostingCommand,
} from '../domain/ledger.js';
import type {
  OwnershipBinding,
  StockOwnershipMode,
} from '../domain/ownership.js';
import type { StockReservation } from '../domain/reservations.js';
import type {
  LedgerReceipt,
  LedgerTransaction,
  ShadowComparison,
  StockEvidence,
} from './ledger.js';
import type { createReservationService } from './reservations.js';
import type { createStockOwnershipService } from './stock-ownership.js';

/** A Sales-owned record supplies exact order lines without exposing personal customer fields. */
export interface NativeStockDemand {
  orderId: string;
  version: number;
  status: 'open' | 'completed' | 'cancelled';
  connectionId: string;
  lines: {
    id: string;
    skuId: string | null;
    skuCode: string | null;
    title: string | null;
    unit: string;
    currentQuantity: string;
  }[];
}

/** A fresh complete provider read retains shipment identity, source mapping and line/location quantities. */
export interface ShipmentRead {
  id: string;
  connectionId: string;
  orderId: string;
  orderExternalId: string;
  orderScopeKey: string;
  observedAt: string;
  complete: boolean;
  mappingVersion: string;
  bindings: {
    resource: 'order' | 'order_line' | 'location' | 'fulfillment';
    externalId: string;
    scopeKey: string;
    canonicalId: string;
    mappingId: string;
  }[];
  shipments: {
    id: string;
    snapshotId: string;
    observationId: string;
    locationId: string | null;
    status: 'shipped' | 'delivered' | 'cancelled' | 'pending' | 'unknown';
    lines: { orderLineId: string; quantity: string; unit: string }[];
  }[];
}

/** Native mode never authorizes provider publication by itself. */
export interface StockOwnershipScope {
  connectionId: string;
  locationId: string;
  version: string;
  mode: StockOwnershipMode;
  authorityRevision: number;
  lastTransitionId: string | null;
  updatedAt: string | null;
}

/** A decision binds the exact source, stock and authority knowledge prepared for one transition. */
export interface StockOwnershipReview {
  id: string;
  key: string;
  intentHash: string;
  from: StockOwnershipMode;
  to: StockOwnershipMode;
  binding: OwnershipBinding;
  preparedBy: string;
  reviewedBy: string | null;
  state: 'pending' | 'approved' | 'rejected';
  reason: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ReservationResult {
  key: string;
  commandHash: string;
  reservation: StockReservation | null;
  allocated: string;
  unallocated: string;
  ledger: LedgerReceipt | null;
  orderVersion: number;
}

export interface AllocationInput {
  id: string;
  key: string;
  reservationId: string;
  orderId: string;
  orderLineId: string;
  orderVersion: number;
  connectionId: string;
  locationId: string;
  quantity: string;
  unit: string;
  expiresAt: string | null;
  reservationVersion: string | null;
  available: { balance: string; version: string };
  ownershipVersion: string;
  authorityRevision: number;
  shipmentReadId: string;
}

/** Inventory owns these records; owner ports provide Sales reads and independently recorded shipment evidence. */
export interface NativeStockTransaction {
  ledger: LedgerTransaction;
  lockOrder(orderId: string): Promise<void>;
  /** Serializes handover with Sales changes before location or reservation locks. */
  lockOwnership(): Promise<void>;
  demand(
    orderId: string,
    requireAuthority?: boolean,
  ): Promise<NativeStockDemand | null>;
  scope(
    connectionId: string | null,
    locationId: string,
    lock: boolean,
  ): Promise<StockOwnershipScope>;
  authorityRevision(): Promise<number>;
  /** Unknown or in-flight external effects prevent releases and handback. */
  unsettled(
    connectionId: string,
    locationId: string,
    orderId?: string,
  ): Promise<boolean>;
  shipmentRead(id: string): Promise<ShipmentRead | null>;
  latestShipmentRead(
    orderId: string,
    connectionId: string,
  ): Promise<ShipmentRead | null>;
  saveShipmentRead(value: ShipmentRead): Promise<void>;
  dueReservations(
    before: string,
    limit: number,
    orderId?: string,
  ): Promise<StockReservation[]>;
  reservations(orderId: string, lock: boolean): Promise<StockReservation[]>;
  reservation(id: string, lock: boolean): Promise<StockReservation | null>;
  saveReservation(
    value: StockReservation,
    expectedVersion: string | null,
  ): Promise<void>;
  reservationReceipt(
    key: string,
    hash: string,
  ): Promise<ReservationResult | null>;
  rememberReservation(result: ReservationResult): Promise<void>;
  /** Quantities consumed by exact shipment/line identity are retained unchanged for repeated reads. */
  consumptionReceipt(
    key: string,
    hash: string,
  ): Promise<ConsumptionResult | null>;
  rememberConsumption(result: ConsumptionResult): Promise<void>;
  saveConsumption(
    id: string,
    connectionId: string,
    shipmentId: string,
    orderLineId: string,
    reservationId: string,
    readId: string,
    entryId: string,
    quantity: string,
  ): Promise<void>;
  shipmentClaim(
    connectionId: string,
    shipmentId: string,
    orderLineId: string,
  ): Promise<string>;
  rememberShipmentClaim(
    connectionId: string,
    shipmentId: string,
    orderLineId: string,
    quantity: string,
    readId: string,
  ): Promise<void>;
  /** Captures all reviewed pools, fresh zero-drift comparisons, mappings and current reservation versions. */
  ownershipEvidence(
    connectionId: string,
    locationId: string,
  ): Promise<OwnershipEvidence>;
  ownershipReview(id: string): Promise<StockOwnershipReview | null>;
  ownershipReviewByKey(key: string): Promise<StockOwnershipReview | null>;
  saveOwnershipReview(value: StockOwnershipReview): Promise<void>;
  decideOwnership(
    value: StockOwnershipReview,
    approved: boolean,
    actorId: string,
  ): Promise<StockOwnershipReview>;
  transitionReceipt(id: string): Promise<StockOwnershipScope | null>;
  transition(value: StockOwnershipReview): Promise<StockOwnershipScope>;
  /** Writes Inventory audit in the same transaction as its command result. */
  audit(
    id: string,
    key: string,
    event: string,
    details: Record<string, string>,
  ): Promise<void>;
}

export interface NativeStockStore {
  transaction<T>(
    context: TenantContext,
    operation: (tx: NativeStockTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Boundary parsing and stable hashing are installed by composition. */
export interface NativeStockDependencies {
  store: NativeStockStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  reviewerContext(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<TenantContext>;
  hash(value: unknown): string;
  allocation(input: AllocationInput): AllocationInput;
  release(input: ReleaseInput): ReleaseInput;
  now?: () => Date;
}

/** Builds expected-version postings from the accounts locked by the Inventory owner. */
export function reservationMovement(
  input: {
    id: string;
    key: string;
    reason: string;
    effectiveAt: string | null;
    purpose: PostingCommand['purpose'];
    evidence: PostingCommand['evidence'];
  },
  from: LedgerAccount,
  to: LedgerAccount,
  quantity: string,
): PostingCommand {
  return {
    ...input,
    postings: [
      { account: from.address, quantity: `-${quantity}` },
      { account: to.address, quantity },
    ],
    expected: [from, to].map((account) => ({
      account: account.address,
      balance: account.balance,
      version: account.version,
    })),
  };
}

/** Exact physical account identity; connection belongs to the ownership scope, not the shared stock pool. */
export function reservationAddress(
  value: { skuId: string; locationId: string; unit: string },
  state: 'available' | 'reserved' | 'customer',
): AccountAddress {
  return {
    skuId: value.skuId,
    locationId: value.locationId,
    unit: value.unit,
    state,
  };
}

/** Release commands bind one current reservation and fresh settled shipment evidence. */
export interface ReleaseInput {
  id: string;
  key: string;
  reservationId: string;
  version: string;
  quantity: string;
  reason: 'release' | 'cancel' | 'amend' | 'expiry';
  shipmentReadId: string;
}

/** Owner reads preserve raw opening, provider and native evidence for application admission rules. */
export interface OwnershipEvidence {
  scope: StockOwnershipScope;
  authorityRevision: number;
  unsettled: boolean;
  pools: {
    skuId: string;
    unit: string;
    openingReviewId: string;
    opening: StockEvidence;
    source: StockEvidence | null;
    comparison: ShadowComparison | null;
    accounts: LedgerAccount[];
  }[];
  reservations: StockReservation[];
}

/** Public shared runtime surface for native stock ownership and reservations. */
export interface NativeStockRuntime {
  store: NativeStockStore;
  ledger: import('./ledger-service.js').LedgerService;
  read: NativeStockReader;
  readStock(
    context: TenantContext,
    input: {
      connectionId: string;
      skuId: string;
      locationId: string;
      unit: string;
    },
  ): Promise<StockEvidence>;
  readShipments(
    context: TenantContext,
    orderId: string,
    connectionId: string,
  ): Promise<ShipmentRead>;
  reservations: ReturnType<typeof createReservationService>;
  ownership: ReturnType<typeof createStockOwnershipService>;
}

/** Original results distinguish verified physical consumption from allocation preparation. */
export interface ConsumptionResult {
  key: string;
  commandHash: string;
  consumed: string;
  reservations: StockReservation[];
  ledger: LedgerReceipt[];
  shipmentReadId: string;
}

/** Reader contracts retain stock and source authority as distinct records. */
export interface NativeStockReader {
  pool(
    context: TenantContext,
    input: {
      skuId: string;
      locationId: string;
      unit: string;
      connectionId: string;
    },
  ): Promise<{
    skuId: string;
    locationId: string;
    unit: string;
    scope: StockOwnershipScope;
    opened: boolean;
    accounts: LedgerAccount[];
    pendingReviews: {
      id: string;
      purpose: string;
      preparedBy: string;
      state: 'pending' | 'approved' | 'rejected';
      createdAt: string;
    }[];
    ownershipReviews: {
      id: string;
      from: StockOwnershipMode;
      to: StockOwnershipMode;
      preparedBy: string;
      state: 'pending' | 'approved' | 'rejected';
    }[];
  }>;
  order(
    context: TenantContext,
    orderId: string,
  ): Promise<{
    orderId: string;
    reservations: StockReservation[];
    demand: NativeStockDemand | null;
  }>;
}
