import type {
  CommerceObservation,
  ExternalId,
  SourceIdentity,
  SourceRecords,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { CommerceProjections as Inventory } from '@luma/inventory';
import type { CommerceProjections as Orders } from '@luma/orders';

import { LinkError } from './errors.js';
import { validateOrderLineIdentity } from './order-line-links.js';
import { orderParent, prepareOrderChildren } from './order-links.js';
import { planObservation } from './planners/index.js';
import { identityKey, type Plan, positionKey } from './planning.js';
import { sourceLocalKey } from './source-local.js';

export type ProjectionOutcome =
  | { status: 'pending'; missing: SourceIdentity[] }
  | { status: 'applied' | 'retained' | 'duplicate'; entityId: string };

/** Mapping method recorded for identities created by a history import or sync. */
const sourceLocalMethod =
  'Imported source record with its own canonical identity';

/** Coordinates idempotent owner transactions; replay resumes after a partial failure. */
export function createCommerceIngestion(
  sources: SourceRecords,
  orders: Orders,
  inventory: Inventory,
  digest: (value: string) => string,
) {
  const dependencies = { sources, orders, inventory, digest };

  /** Resolves any number of identities in reads within the source lookup's batch limit. */
  async function resolveAll(context: TenantContext, all: SourceIdentity[]) {
    const found = new Map<string, string>();
    for (let start = 0; start < all.length; start += resolveBatch)
      for (const [key, id] of await sources.resolveMany(
        context,
        all.slice(start, start + resolveBatch),
      ))
        found.set(key, id);

    return found;
  }

  /**
   * Projects stored observations in input order. Children of linked orders are re-keyed first;
   * owners then apply their snapshots in one batch each. Any failure rejects the batch.
   */
  async function projectMany(
    context: TenantContext,
    inputs: CommerceObservation[],
  ): Promise<ProjectionOutcome[]> {
    if (!inputs.length) return [];
    const parents = inputs.map(orderParent);
    const parentIds = await resolveAll(
      context,
      parents.filter((parent) => parent !== null),
    );
    const revised = await sources.revised(context, 'order', [
      ...parentIds.values(),
    ]);
    for (const [index, input] of inputs.entries()) {
      const parent = parents[index];
      const id = parent && parentIds.get(identityKey(parent));
      if (id && revised.has(id))
        await prepareOrderChildren(context, input, sources, orders);
    }
    const known = await resolveAll(context, unique(inputs.flatMap(identities)));
    const positions = await inventory.identifyMany(
      context,
      inputs.flatMap((input) => {
        if (input.capability !== 'inventory.read') return [];
        const data = input.observation.data;
        const source = input.observation.source;
        const skuId = known.get(
          identityKey({ ...source, ...data.sku, resource: 'sku' }),
        );
        const locationId = known.get(
          identityKey({ ...source, ...data.location, resource: 'location' }),
        );

        return skuId && locationId
          ? [
              {
                kind: 'position' as const,
                reconciliationKey: positionKey(skuId, locationId, data.unit),
              },
            ]
          : [];
      }),
    );
    const parentOrders = await orders.currentMany(
      context,
      inputs.flatMap((input, index) => {
        const parent = parents[index];
        const id =
          input.capability !== 'orders.read' &&
          parent &&
          known.get(identityKey(parent));

        return id ? [id] : [];
      }),
    );
    const plans: Plan[] = [];
    for (const input of inputs)
      plans.push(
        await planObservation(
          dependencies,
          context,
          input,
          known,
          positions,
          parentOrders,
        ),
      );
    const statuses = {
      orders: await orders.projectMany(
        context,
        plans.flatMap((item) =>
          'owner' in item && item.owner === 'orders' ? [item.snapshot] : [],
        ),
      ),
      inventory: await inventory.projectMany(
        context,
        plans.flatMap((item) =>
          'owner' in item && item.owner === 'inventory' ? [item.snapshot] : [],
        ),
      ),
    };
    const next = { orders: 0, inventory: 0 };

    return plans.map((item) =>
      'owner' in item
        ? {
            status: statuses[item.owner][next[item.owner]++]!,
            entityId: item.snapshot.entityId,
          }
        : item,
    );
  }

  return {
    async ingest(
      context: TenantContext,
      ingestKey: string,
      input: CommerceObservation,
    ) {
      requireTenant(context, context.tenantId);
      const stored = await sources.record(context, ingestKey, input);

      return (await projectMany(context, [stored]))[0]!;
    },
    async replay(
      context: TenantContext,
      connectionId: string,
      ingestKey: string,
    ) {
      const stored = await sources.get(context, connectionId, ingestKey);
      if (!stored) throw new Error('Observation not found');

      return (await projectMany(context, [stored]))[0]!;
    },
    bind,
    async import(
      context: TenantContext,
      ingestKey: string,
      input: CommerceObservation,
    ) {
      return (await importMany(context, [{ ingestKey, input }]))[0]!;
    },
    importMany,
    /** Confirms shared identity and replays affected records. Supply an audited method for automatic rules; manual callers use the default. */
    async link(
      context: TenantContext,
      kind: LinkableKind,
      targetId: string,
      otherId: string,
      reason: string,
      method: string = linkedMethod,
    ) {
      requirePermission(context, 'sync.manage');
      if (targetId === otherId)
        throw new LinkError('These are the same record');
      const [target, other] = await Promise.all([
        sources.mappings(context, kind, targetId),
        sources.mappings(context, kind, otherId),
      ]);
      if (!target.length)
        throw new LinkError('The record to link to was not found');
      if (kind === 'order_line' && !other.length) {
        const moved = target.filter(
          (item) => item.previousCanonicalId === otherId,
        );
        if (!moved.length)
          throw new LinkError('The other order line was not found');
        const parent = await validateOrderLineIdentity(
          orders,
          context,
          targetId,
          targetId,
          target,
          target,
        );
        if ((await orders.childParent(context, otherId)) !== parent)
          throw new LinkError(
            'Link the parent orders before matching their lines',
          );
        // Mapping and replay committed before the worker marked its request complete.
        for (const connectionId of new Set(
          moved.map((item) => item.source.connectionId),
        ))
          await reprojectOrder(context, parent, connectionId, reason);

        return { moved: 0 };
      }
      if (
        other.some((item) =>
          target.some(
            (t) => t.source.connectionId === item.source.connectionId,
          ),
        )
      )
        throw new LinkError(
          'Both records come from the same connection, so they cannot be the same record',
        );
      const lineParent =
        kind === 'order_line'
          ? await validateOrderLineIdentity(
              orders,
              context,
              targetId,
              otherId,
              target,
              other,
            )
          : null;
      for (const item of other)
        await sources.remap(
          context,
          item.source,
          otherId,
          targetId,
          method,
          reason,
        );
      if (kind === 'order') {
        await reprojectOrder(context, otherId, undefined, reason);

        return { moved: other.length };
      }
      if (kind === 'order_line') {
        if (!lineParent)
          throw new LinkError('The order line has no linked parent order');
        for (const connectionId of new Set(
          other.map((item) => item.source.connectionId),
        ))
          await reprojectOrder(context, lineParent, connectionId, reason);

        return { moved: other.length };
      }
      // Anything still referring to the other record is stale after its sources moved.
      await reproject(context, kind, otherId, undefined, reason);

      return { moved: other.length };
    },
    async unlink(
      context: TenantContext,
      kind: LinkableKind,
      entityId: string,
      connectionId: string,
      reason: string,
    ) {
      requirePermission(context, 'sync.manage');
      const mappings = await sources.mappings(context, kind, entityId);
      const own = mappings.filter(
        (item) => item.source.connectionId === connectionId,
      );
      if (own.length && own.length === mappings.length)
        throw new LinkError('This record is not linked to another source');
      for (const item of own) {
        const identify = (key: string) =>
          kind === 'order' || kind === 'order_line'
            ? orders.identify(context, kind, key)
            : inventory.identify(context, kind, key);
        const parent =
          kind === 'order_line'
            ? await orders.childParent(context, entityId)
            : null;
        if (kind === 'order_line' && !parent)
          throw new LinkError('The order line has no linked parent order');
        let target = await identify(
          kind === 'order_line'
            ? JSON.stringify([
                'line-unlink',
                parent,
                sourceLocalKey(item.source),
                entityId,
              ])
            : sourceLocalKey(item.source),
        );
        // The source may have been this record's origin; give it a new record instead.
        if (target === entityId)
          target = await identify(
            JSON.stringify(['split', sourceLocalKey(item.source), entityId]),
          );
        await sources.remap(
          context,
          item.source,
          entityId,
          target,
          unlinkedMethod,
          reason,
        );
      }
      if (kind === 'order')
        await reprojectOrder(context, entityId, connectionId, reason);
      else if (kind === 'order_line') {
        const parent = await orders.childParent(context, entityId);
        if (parent) await reprojectOrder(context, parent, connectionId, reason);
      } else await reproject(context, kind, entityId, connectionId, reason);

      return { moved: own.length };
    },
  };

  /**
   * Stores observations, binds every unmapped identity they carry to a source-local entity and
   * projects them in input order. Any failure rejects the batch.
   */
  async function importMany(
    context: TenantContext,
    items: { ingestKey: string; input: CommerceObservation }[],
  ): Promise<ProjectionOutcome[]> {
    requirePermission(context, 'sync.manage');
    const stored = await sources.recordMany(context, items);
    const evidence = new Map<string, string>();
    for (const item of stored)
      for (const source of identities(item))
        if (!evidence.has(identityKey(source)))
          evidence.set(identityKey(source), item.observation.id);
    const all = unique(stored.flatMap(identities));
    const mapped = await resolveAll(context, all);
    const unmapped = all.filter((source) => !mapped.has(identityKey(source)));
    const keys = unmapped.map((source) => sourceLocalEntity(source));
    const created = new Map([
      ...(await orders.identifyMany(
        context,
        keys.flatMap((key) => (key.owner === 'orders' ? [key.entity] : [])),
      )),
      ...(await inventory.identifyMany(
        context,
        keys.flatMap((key) => (key.owner === 'inventory' ? [key.entity] : [])),
      )),
    ]);
    await sources.bindMany(
      context,
      unmapped.map((source, index) => ({
        source,
        canonicalId: created.get(
          JSON.stringify([
            keys[index]!.entity.kind,
            keys[index]!.entity.reconciliationKey,
          ]),
        )!,
        observationId: evidence.get(identityKey(source))!,
        method: sourceLocalMethod,
      })),
    );

    return projectMany(context, stored);
  }

  async function bind(
    context: TenantContext,
    source: SourceIdentity,
    reconciliationKey: string,
    observationId: string,
    method: string,
  ) {
    requirePermission(context, 'sync.manage');
    requireTenant(context, source.tenantId);
    // The key is explicit operator evidence, never an inferred SKU or display number.
    const { owner, entity } = sourceLocalEntity(source, reconciliationKey);
    const id =
      owner === 'orders'
        ? await orders.identify(context, entity.kind, entity.reconciliationKey)
        : await inventory.identify(
            context,
            entity.kind,
            entity.reconciliationKey,
          );
    await sources.bind(context, source, id, observationId, method);

    return id;
  }

  async function reprojectOrder(
    context: TenantContext,
    id: string,
    connectionId: string | undefined,
    reason: string,
  ) {
    const affected = await orders.orderDependents(context, id, connectionId);
    for (const item of affected) {
      const stored = await sources.observation(
        context,
        item.connectionId,
        item.observationId,
      );
      if (!stored) throw new Error('Observation not found');
      const outcome = (await projectMany(context, [stored]))[0]!;
      if (outcome.status === 'pending')
        throw new LinkError(
          'Related order records are not ready. Import the order and try again.',
        );
      if (outcome.entityId !== item.entityId)
        await orders.retire(
          context,
          item.entityId,
          item.connectionId,
          outcome.entityId,
          reason,
        );
    }
  }

  /**
   * Re-projects current snapshots that still refer to `id` after its mappings changed, then
   * removes each source's projection from the record it no longer belongs to.
   */
  async function reproject(
    context: TenantContext,
    kind: Exclude<LinkableKind, 'order' | 'order_line'>,
    id: string,
    connectionId: string | undefined,
    reason: string,
  ) {
    const replay = async (connection: string, observationId: string) => {
      const stored = await sources.observation(
        context,
        connection,
        observationId,
      );
      if (!stored) throw new Error('Observation not found');

      return (await projectMany(context, [stored]))[0]!;
    };
    for (const item of await inventory.dependents(
      context,
      kind,
      id,
      connectionId,
    )) {
      const outcome = await replay(item.connectionId, item.observationId);
      if (outcome.status !== 'pending' && outcome.entityId !== item.entityId)
        await inventory.retire(
          context,
          item.entityId,
          item.connectionId,
          reason,
        );
    }
    if (kind === 'sku')
      for (const item of await orders.skuDependents(context, id, connectionId))
        await replay(item.connectionId, item.observationId);
    if (kind === 'location')
      for (const item of await orders.locationDependents(
        context,
        id,
        connectionId,
      ))
        await replay(item.connectionId, item.observationId);
  }
}

/** Records a person can link or unlink across sources. */
export type LinkableKind = 'sku' | 'location' | 'order' | 'order_line';

const linkedMethod = 'Linked by a person as the same record in another source';

const unlinkedMethod = 'Unlinked by a person from another source';

// `SourceRecords.resolveMany` accepts at most this many identities per read.
const resolveBatch = 10_000;

const unique = (sources: SourceIdentity[]) => [
  ...new Map(sources.map((source) => [identityKey(source), source])).values(),
];

/** The owner entity a source binds to by itself, before any person links it elsewhere. */
function sourceLocalEntity(
  source: SourceIdentity,
  reconciliationKey = sourceLocalKey(source),
):
  | {
      owner: 'orders';
      entity: {
        kind: 'order' | 'order_line' | 'fulfillment' | 'return' | 'refund';
        reconciliationKey: string;
      };
    }
  | {
      owner: 'inventory';
      entity: {
        kind:
          | 'sku'
          | 'location'
          | 'product'
          | 'position'
          | 'inventory_transfer'
          | 'inventory_shipment';
        reconciliationKey: string;
      };
    } {
  const resource = source.resource;
  if (resource === 'customer')
    throw new Error('Customer profiles have no canonical mapping');
  if (resource === 'supplier' || resource === 'purchase_order')
    throw new Error('Procurement owns supplier and purchase-order records');
  if (resource === 'message')
    throw new Error('Messaging owns messages; they are not commerce records');
  if (resource === 'return_reason')
    throw new Error(
      'Return reasons are choices for creating returns, not records',
    );
  if (resource === 'order' || resource === 'order_line')
    return { owner: 'orders', entity: { kind: resource, reconciliationKey } };
  if (
    resource === 'fulfillment' ||
    resource === 'return' ||
    resource === 'refund'
  )
    // One source's operations; mirrored copies in other sources stay separate.
    return {
      owner: 'orders',
      entity: {
        kind: resource,
        reconciliationKey: JSON.stringify([
          source.connectionId,
          reconciliationKey,
        ]),
      },
    };

  return { owner: 'inventory', entity: { kind: resource, reconciliationKey } };
}

/** Every source identity an observation carries, including its parent and line references. */
function identities(input: CommerceObservation): SourceIdentity[] {
  const source = input.observation.source;
  const refs: SourceIdentity[] = [source];
  const add = (resource: SourceIdentity['resource'], external: ExternalId) =>
    refs.push({ ...source, ...external, resource });
  if (
    input.capability === 'inventory.transfers.read' ||
    input.capability === 'inventory.shipments.read'
  ) {
    for (const line of input.observation.data.lines ?? [])
      if (line.sku) add('sku', line.sku);
    if (input.capability === 'inventory.transfers.read') {
      for (const location of [
        input.observation.data.origin,
        input.observation.data.destination,
      ])
        if (location?.id) add('location', location.id);
      for (const shipment of input.observation.data.shipments ?? [])
        add('inventory_shipment', shipment);
    }
  }
  if (input.capability === 'orders.read')
    for (const line of input.observation.data.lines) {
      add('order_line', line.id);
      if (line.sku) add('sku', line.sku);
    }
  if (input.capability === 'inventory.read') {
    refs.length = 0;
    add('sku', input.observation.data.sku);
    add('location', input.observation.data.location);
  }
  if (input.capability === 'products.read')
    for (const sku of input.observation.data.skus) {
      add('sku', sku.id);
      for (const component of sku.bundle?.components ?? [])
        if (component.sku) add('sku', component.sku);
    }
  if (input.capability === 'fulfillment.read') {
    add('order', input.observation.data.order);
    for (const line of input.observation.data.lines)
      add('order_line', line.orderLine);
    if (input.observation.data.location)
      add('location', input.observation.data.location.id);
  }
  if (input.capability === 'returns.read') {
    const data = input.observation.data;
    add('order', data.order);
    for (const line of data.lines)
      if (line.orderLine) add('order_line', line.orderLine);
    if (data.type === 'refund' && data.return) add('return', data.return);
  }

  return [...new Map(refs.map((ref) => [identityKey(ref), ref])).values()];
}
