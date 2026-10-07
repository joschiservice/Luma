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

import {
  orderParent,
  prepareOrderChildren,
} from './application/order-links.js';
import { sourceLocalKey } from './application/source-local.js';

export { sourceLocalKey } from './application/source-local.js';

export type ProjectionOutcome =
  | { status: 'pending'; missing: SourceIdentity[] }
  | { status: 'applied' | 'retained' | 'duplicate'; entityId: string };

// Snapshot identity includes the normalizer version, so bump it whenever the same observation
// would normalize to a different document; replay then adds a new snapshot instead of
// conflicting with the stored one.
const normalizers = {
  inventory: 'commerce/1',
  product: 'commerce/2',
  order: 'commerce/2',
  fulfillment: 'commerce/2',
  return: 'commerce/1',
  refund: 'commerce/1',
} as const;

/** Mapping method recorded for identities created by a history import or sync. */
export const sourceLocalMethod =
  'Imported source record; linked only to itself until a person links it to another source';

/** Coordinates idempotent owner transactions; replay resumes after a partial failure. */
export function createCommerceIngestion(
  sources: SourceRecords,
  orders: Orders,
  inventory: Inventory,
  digest: (value: string) => string,
) {
  /**
   * Resolves one stored observation into its owner's snapshot, or reports the related records
   * it still waits for. Inventory positions use `positions` when it holds their entity, and
   * children use `parents` for their order's current projections.
   */
  async function plan(
    context: TenantContext,
    input: CommerceObservation,
    known: Map<string, string>,
    positions: Map<string, string>,
    parents: Map<string, Projection[]>,
  ): Promise<Plan> {
    const o = input.observation;
    const missing: SourceIdentity[] = [];

    async function lookup(source: SourceIdentity) {
      return known.get(identityKey(source)) ?? sources.resolve(context, source);
    }

    async function resolve(
      resource: SourceIdentity['resource'],
      external: ExternalId,
    ) {
      const source = { ...o.source, ...external, resource };
      const id = await lookup(source);
      if (!id) missing.push(source);

      return id;
    }

    const provenance = {
      schemaVersion: 1 as const,
      connectionId: o.source.connectionId,
      observationId: o.id,
      normalizerVersion: normalizers.inventory,
      sourceRevision: o.sourceRevision,
      sourceUpdatedAt: o.sourceUpdatedAt,
      observedAt: o.observedAt,
      deleted: o.kind === 'tombstone',
    };
    if (input.capability === 'inventory.read') {
      const data = input.observation.data;
      const skuId = await resolve('sku', data.sku),
        locationId = await resolve('location', data.location);
      if (!skuId || !locationId) return { status: 'pending', missing };
      const key = positionKey(skuId, locationId, data.unit);
      const entityId =
        positions.get(JSON.stringify(['position', key])) ??
        (await inventory.identify(context, 'position', key));

      return {
        owner: 'inventory',
        snapshot: {
          ...provenance,
          entityId,
          kind: 'position',
          mappingVersion: digest(JSON.stringify([skuId, locationId])),
          data: {
            type: 'position',
            skuId,
            locationId,
            unit: data.unit,
            onHand: data.onHand,
            reserved: data.reserved,
            available: data.available,
            availabilityBasis: data.availabilityBasis,
          },
        },
      };
    }
    if (input.capability === 'products.read') {
      const data = input.observation.data;
      const entityId = await resolve('product', o.source);
      const skus = [];
      for (const sku of data.skus) {
        const skuId = await resolve('sku', sku.id);
        if (skuId)
          skus.push({
            skuId,
            code: sku.code,
            unit: sku.unit,
            ...(sku.title !== undefined && { title: sku.title }),
            ...(sku.price !== undefined && { price: sku.price }),
            ...(sku.barcode !== undefined && { barcode: sku.barcode }),
          });
      }
      if (!entityId || missing.length) return { status: 'pending', missing };

      return {
        owner: 'inventory',
        snapshot: {
          ...provenance,
          schemaVersion: 2,
          normalizerVersion: normalizers.product,
          entityId,
          kind: 'product',
          mappingVersion: digest(
            JSON.stringify([entityId, skus.map((sku) => sku.skuId)]),
          ),
          data: {
            type: 'product',
            title: data.title,
            status: data.status,
            ...(data.vendor !== undefined && { vendor: data.vendor }),
            ...(data.published !== undefined && { published: data.published }),
            skus,
          },
        },
      };
    }
    if (input.capability === 'orders.read') {
      const entityId = await resolve('order', o.source);
      const data = input.observation.data;
      const lines = [];
      for (const line of data.lines) {
        const id = await resolve('order_line', line.id);
        // An unknown SKU does not prevent storing order facts.
        const skuId = line.sku
          ? await lookup({ ...o.source, ...line.sku, resource: 'sku' })
          : null;
        if (id)
          lines.push({
            id,
            skuId,
            quantity: line.quantity.amount,
            cancelledQuantity: line.cancelledQuantity?.amount ?? null,
            unit: line.quantity.unit,
            ...(line.skuCode === undefined ? {} : { skuCode: line.skuCode }),
            ...(line.title === undefined ? {} : { title: line.title }),
          });
      }
      if (!entityId || missing.length) return { status: 'pending', missing };

      return {
        owner: 'orders',
        snapshot: {
          ...provenance,
          schemaVersion: 2,
          normalizerVersion: normalizers.order,
          entityId,
          kind: 'order',
          mappingVersion: digest(
            JSON.stringify([entityId, lines.map((l) => [l.id, l.skuId])]),
          ),
          data: {
            type: 'order',
            displayNumber: data.displayNumber,
            ...(data.dueAt === undefined ? {} : { dueAt: data.dueAt }),
            ...(data.placedAt === undefined ? {} : { placedAt: data.placedAt }),
            ...(data.total === undefined ? {} : { total: data.total }),
            status: data.status,
            paymentStatus: data.paymentStatus,
            lines,
          },
        },
      };
    }
    if (input.capability === 'returns.read') {
      const data = input.observation.data;
      const entityId = await resolve(data.type, o.source),
        orderId = await resolve('order', data.order);
      const lineIds: (string | null)[] = [];
      for (const line of data.lines)
        lineIds.push(
          line.orderLine ? await resolve('order_line', line.orderLine) : null,
        );
      const returnId =
        data.type === 'refund' && data.return
          ? await resolve('return', data.return)
          : null;
      if (!entityId || !orderId || missing.length)
        return { status: 'pending', missing };
      const parent = (
        parents.get(orderId) ?? (await orders.current(context, orderId))
      ).find((p) => p.snapshot.connectionId === o.source.connectionId);
      if (
        !parent ||
        parent.snapshot.deleted ||
        parent.snapshot.data.type !== 'order'
      )
        return {
          status: 'pending',
          missing: [{ ...o.source, ...data.order, resource: 'order' }],
        };
      const common = {
        ...provenance,
        normalizerVersion: normalizers[data.type],
        entityId,
        mappingVersion: digest(
          JSON.stringify([entityId, orderId, lineIds, returnId]),
        ),
      };

      return {
        owner: 'orders',
        snapshot:
          data.type === 'return'
            ? {
                ...common,
                kind: 'return',
                data: {
                  type: 'return',
                  orderId,
                  name: data.name,
                  status: data.status,
                  requestedAt: data.requestedAt,
                  approvedAt: data.approvedAt,
                  closedAt: data.closedAt,
                  declineReason: data.declineReason,
                  receivedAt: data.receivedAt,
                  lines: data.lines.map((line, index) => ({
                    orderLineId: lineIds[index] ?? null,
                    quantity: line.quantity.amount,
                    unit: line.quantity.unit,
                    reason: line.reason,
                    receivedQuantity: line.receivedQuantity,
                    restockedQuantity: line.restockedQuantity,
                    refundedQuantity: line.refundedQuantity,
                    value: line.value,
                  })),
                },
              }
            : {
                ...common,
                kind: 'refund',
                data: {
                  type: 'refund',
                  orderId,
                  returnId,
                  createdAt: data.createdAt,
                  total: data.total,
                  lines: data.lines.map((line, index) => ({
                    orderLineId: lineIds[index]!,
                    quantity: line.quantity.amount,
                    unit: line.quantity.unit,
                    restock: line.restock,
                    restocked: line.restocked,
                  })),
                  transactions: data.transactions,
                },
              },
      };
    }
    const data = input.observation.data;
    const entityId = await resolve('fulfillment', o.source),
      orderId = await resolve('order', data.order);
    const lines = [];
    for (const line of data.lines) {
      const orderLineId = await resolve('order_line', line.orderLine);
      if (orderLineId)
        lines.push({
          orderLineId,
          quantity: line.quantity.amount,
          unit: line.quantity.unit,
        });
    }
    // An unknown location does not prevent storing fulfillment facts.
    const locationId = data.location
      ? await lookup({ ...o.source, ...data.location.id, resource: 'location' })
      : null;
    if (!entityId || !orderId || missing.length)
      return { status: 'pending', missing };
    const parent = (
      parents.get(orderId) ?? (await orders.current(context, orderId))
    ).find((p) => p.snapshot.connectionId === o.source.connectionId);
    if (
      !parent ||
      parent.snapshot.deleted ||
      parent.snapshot.data.type !== 'order'
    )
      return {
        status: 'pending',
        missing: [{ ...o.source, ...data.order, resource: 'order' }],
      };
    const parentLines = parent.snapshot.data.lines;
    if (
      lines.some(
        (l) =>
          !parentLines.some((p) => p.id === l.orderLineId && p.unit === l.unit),
      )
    )
      throw new Error(
        'Fulfillment line must belong to its order and use the same unit',
      );
    const optional = <K extends keyof typeof data>(key: K) =>
      data[key] === undefined ? {} : { [key]: data[key] };

    return {
      owner: 'orders',
      snapshot: {
        ...provenance,
        schemaVersion: 2,
        normalizerVersion: normalizers.fulfillment,
        entityId,
        kind: 'fulfillment',
        mappingVersion: digest(
          JSON.stringify([
            entityId,
            orderId,
            lines.map((l) => l.orderLineId),
            locationId,
          ]),
        ),
        data: {
          type: 'fulfillment',
          orderId,
          status: data.status,
          lastProgressAt: data.lastProgressAt,
          failureCode: data.failureCode,
          lines,
          ...optional('kind'),
          ...optional('holds'),
          ...(data.location === undefined
            ? {}
            : {
                location: data.location
                  ? { locationId, name: data.location.name }
                  : null,
              }),
          ...optional('fulfillAt'),
          ...optional('fulfillBy'),
          ...optional('estimatedDeliveryAt'),
          ...optional('method'),
          ...optional('tracking'),
          ...optional('delivery'),
        },
      },
    };
  }

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
      plans.push(await plan(context, input, known, positions, parentOrders));
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
    async link(
      context: TenantContext,
      kind: LinkableKind,
      targetId: string,
      otherId: string,
      reason: string,
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
      for (const item of other)
        await sources.remap(
          context,
          item.source,
          otherId,
          targetId,
          linkedMethod,
          reason,
        );
      if (kind === 'order') {
        await reprojectOrder(context, otherId, undefined, reason);

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
          kind === 'order'
            ? orders.identify(context, kind, key)
            : inventory.identify(context, kind, key);
        let target = await identify(sourceLocalKey(item.source));
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
      else await reproject(context, kind, entityId, connectionId, reason);

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
    kind: Exclude<LinkableKind, 'order'>,
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

export type LinkableKind = 'sku' | 'location' | 'order';

/** A link request that cannot be applied as asked; the message is written for the requester. */
export class LinkError extends Error {}

const linkedMethod = 'Linked by a person as the same record in another source';

const unlinkedMethod = 'Unlinked by a person from another source';

const identityKey = (source: SourceIdentity) =>
  JSON.stringify([
    source.connectionId,
    source.resource,
    source.scopeKey,
    source.externalId,
  ]);

type OrderSnapshot = Parameters<Orders['project']>[1];

type Projection = Awaited<ReturnType<Orders['current']>>[number];

type InventorySnapshot = Parameters<Inventory['project']>[1];

type Plan =
  | { status: 'pending'; missing: SourceIdentity[] }
  | { owner: 'orders'; snapshot: OrderSnapshot }
  | { owner: 'inventory'; snapshot: InventorySnapshot };

// `SourceRecords.resolveMany` accepts at most this many identities per read.
const resolveBatch = 10_000;

const positionKey = (skuId: string, locationId: string, unit: string) =>
  JSON.stringify([skuId, locationId, unit]);

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
        kind: 'sku' | 'location' | 'product' | 'position';
        reconciliationKey: string;
      };
    } {
  const resource = source.resource;
  if (resource === 'customer')
    throw new Error('Customer profiles have no canonical mapping');
  if (resource === 'supplier' || resource === 'purchase_order')
    throw new Error('Procurement owns supplier and purchase-order records');
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
    for (const sku of input.observation.data.skus) add('sku', sku.id);
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
