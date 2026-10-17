import type {
  CommerceObservation,
  ExternalId,
  SourceIdentity,
  SourceRecords,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { CommerceProjections as Inventory } from '@luma/inventory';
import type { CommerceProjections as Orders } from '@luma/orders';

// Snapshot identity includes the normalizer version, so bump it whenever the same observation
// would normalize to a different document; replay then adds a new snapshot instead of
// conflicting with the stored one.
export const normalizers = {
  inventory: 'commerce/4',
  inventoryTransfers: 'commerce/1',
  inventoryShipments: 'commerce/1',
  product: 'commerce/3',
  order: 'commerce/7',
  fulfillment: 'commerce/5',
  return: 'commerce/1',
  refund: 'commerce/1',
} as const;

type OrderSnapshot = Parameters<Orders['project']>[1];

type InventorySnapshot = Parameters<Inventory['project']>[1];

/** An order's current projection, as an owner reports it per source connection. */
export type Projection = Awaited<ReturnType<Orders['current']>>[number];

/** One observation resolved into its owner's snapshot, or the related records it waits for. */
export type Plan =
  | { status: 'pending'; missing: SourceIdentity[] }
  | { owner: 'orders'; snapshot: OrderSnapshot }
  | { owner: 'inventory'; snapshot: InventorySnapshot };

/** The capabilities whose observations become canonical commerce records. */
export type CommerceCapability = CommerceObservation['capability'];

/** The stored observation of one commerce capability. */
export type ObservationOf<C extends CommerceCapability> = Extract<
  CommerceObservation,
  { capability: C }
>;

/** The owners and digest a planner reads from; planners never write. */
export interface PlanDependencies {
  sources: SourceRecords;
  orders: Orders;
  inventory: Inventory;
  digest: (value: string) => string;
}

/** What a planner knows while resolving one observation. */
export interface PlanScope extends PlanDependencies {
  context: TenantContext;
  /** Inventory position entities already identified for this batch, by entity key. */
  positions: Map<string, string>;
  /** Current projections of parent orders already read for this batch, by order ID. */
  parents: Map<string, Projection[]>;
  /** Identities `resolve` could not find; a pending plan reports them. */
  missing: SourceIdentity[];
  /** Snapshot fields every owner snapshot copies from the observation. */
  provenance: {
    schemaVersion: 1;
    connectionId: string;
    observationId: string;
    normalizerVersion: string;
    sourceRevision: string | null;
    sourceUpdatedAt: string | null;
    observedAt: string;
    deleted: boolean;
  };
  /** Finds the canonical ID of a source identity, from the batch's reads first. */
  lookup(source: SourceIdentity): Promise<string | null>;
  /**
   * Finds the canonical ID of a related record in the observation's source, and records it in
   * `missing` when it is not mapped yet.
   */
  resolve(
    resource: SourceIdentity['resource'],
    external: ExternalId,
  ): Promise<string | null>;
}

/** Resolves one observation of capability `C` into a plan. */
export type Planner<C extends CommerceCapability> = (
  input: ObservationOf<C>,
  scope: PlanScope,
) => Promise<Plan>;

/** Batch key of a source identity; the same key `SourceRecords.resolveMany` returns. */
export const identityKey = (source: SourceIdentity) =>
  JSON.stringify([
    source.connectionId,
    source.resource,
    source.scopeKey,
    source.externalId,
  ]);

/** Reconciliation key of an inventory position. */
export const positionKey = (skuId: string, locationId: string, unit: string) =>
  JSON.stringify([skuId, locationId, unit]);

/**
 * The order document that connection `connectionId` currently projects for order `orderId`,
 * read from the batch when it holds the order. Undefined when that source has no live order
 * projection yet.
 */
export async function sourceOrder(
  scope: PlanScope,
  orderId: string,
  connectionId: string,
) {
  const parent = (
    scope.parents.get(orderId) ??
    (await scope.orders.current(scope.context, orderId))
  ).find((p) => p.snapshot.connectionId === connectionId);
  if (!parent || parent.snapshot.deleted) return undefined;
  const data = parent.snapshot.data;

  return data.type === 'order' ? data : undefined;
}
