import type { CommerceObservation, SourceIdentity } from '@luma/connections';
import type { TenantContext } from '@luma/identity';

import {
  type CommerceCapability,
  identityKey,
  normalizers,
  type ObservationOf,
  type Plan,
  type PlanDependencies,
  type Planner,
  type PlanScope,
  type Projection,
} from '../planning.js';
import { planFulfillment } from './fulfillments.js';
import { planInventoryPosition } from './inventory-positions.js';
import { planInventoryShipment } from './inventory-shipments.js';
import { planInventoryTransfer } from './inventory-transfers.js';
import { planOrder } from './orders.js';
import { planProduct } from './products.js';
import { planReturn } from './returns.js';

const planners: { [C in CommerceCapability]: Planner<C> } = {
  'inventory.transfers.read': planInventoryTransfer,
  'inventory.shipments.read': planInventoryShipment,
  'inventory.read': planInventoryPosition,
  'products.read': planProduct,
  'orders.read': planOrder,
  'returns.read': planReturn,
  'fulfillment.read': planFulfillment,
};

const dispatch = <C extends CommerceCapability>(
  capability: C,
  input: ObservationOf<C>,
  scope: PlanScope,
) => planners[capability](input, scope);

/**
 * Resolves one stored observation into its owner's snapshot, or reports the related records it
 * still waits for. `known` holds the batch's resolved identities by identity key; inventory
 * positions use `positions` when it holds their entity, and children use `parents` for their
 * order's current projections. Reads owners and source mappings; never writes.
 */
export function planObservation(
  dependencies: PlanDependencies,
  context: TenantContext,
  input: CommerceObservation,
  known: Map<string, string>,
  positions: Map<string, string>,
  parents: Map<string, Projection[]>,
): Promise<Plan> {
  const o = input.observation;
  const missing: SourceIdentity[] = [];
  const lookup = async (source: SourceIdentity) =>
    known.get(identityKey(source)) ??
    dependencies.sources.resolve(context, source);

  return dispatch(input.capability, input, {
    ...dependencies,
    context,
    positions,
    parents,
    missing,
    provenance: {
      schemaVersion: 1,
      connectionId: o.source.connectionId,
      observationId: o.id,
      normalizerVersion: normalizers.inventory,
      sourceRevision: o.sourceRevision,
      sourceUpdatedAt: o.sourceUpdatedAt,
      observedAt: o.observedAt,
      deleted: o.kind === 'tombstone',
    },
    lookup,
    async resolve(resource, external) {
      const source = { ...o.source, ...external, resource };
      const id = await lookup(source);
      if (!id) missing.push(source);

      return id;
    },
  });
}
