import type {
  CommerceObservation,
  ExternalId,
  SourceIdentity,
  SourceRecords,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
import type { CommerceProjections as Inventory } from '@luma/inventory';
import type { CommerceProjections as Orders } from '@luma/orders';

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

/**
 * The reconciliation key of a canonical entity that represents exactly one source record.
 * Another source joins it only through an explicit link.
 */
export function sourceLocalKey(source: SourceIdentity) {
  return JSON.stringify([
    'source',
    source.connectionId,
    source.resource,
    source.scopeKey,
    source.externalId,
  ]);
}

/** Coordinates idempotent owner transactions; replay resumes after a partial failure. */
export function createCommerceIngestion(
  sources: SourceRecords,
  orders: Orders,
  inventory: Inventory,
  digest: (value: string) => string,
) {
  async function project(
    context: TenantContext,
    input: CommerceObservation,
  ): Promise<ProjectionOutcome> {
    const o = input.observation;
    const missing: SourceIdentity[] = [];
    const known = await sources.resolveMany(context, identities(input));

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
      const entityId = await inventory.identify(
        context,
        'position',
        JSON.stringify([skuId, locationId, data.unit]),
      );
      const status = await inventory.project(context, {
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
      });

      return { status, entityId };
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
      const status = await inventory.project(context, {
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
      });

      return { status, entityId };
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
      const status = await orders.project(context, {
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
      });

      return { status, entityId };
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
      const parent = (await orders.current(context, orderId)).find(
        (p) => p.snapshot.connectionId === o.source.connectionId,
      );
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
      const status =
        data.type === 'return'
          ? await orders.project(context, {
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
            })
          : await orders.project(context, {
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
            });

      return { status, entityId };
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
    const parent = (await orders.current(context, orderId)).find(
      (p) => p.snapshot.connectionId === o.source.connectionId,
    );
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
    const status = await orders.project(context, {
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
    });

    return { status, entityId };
  }

  return {
    async ingest(
      context: TenantContext,
      ingestKey: string,
      input: CommerceObservation,
    ) {
      requireTenant(context, context.tenantId);

      return project(context, await sources.record(context, ingestKey, input));
    },
    async replay(
      context: TenantContext,
      connectionId: string,
      ingestKey: string,
    ) {
      const stored = await sources.get(context, connectionId, ingestKey);
      if (!stored) throw new Error('Observation not found');

      return project(context, stored);
    },
    bind,
    async import(
      context: TenantContext,
      ingestKey: string,
      input: CommerceObservation,
    ) {
      requireRole(context, ['owner', 'admin']);
      const stored = await sources.record(context, ingestKey, input);
      const all = identities(stored);
      const mapped = await sources.resolveMany(context, all);
      for (const source of all)
        if (!mapped.has(identityKey(source)))
          await bind(
            context,
            source,
            sourceLocalKey(source),
            stored.observation.id,
            sourceLocalMethod,
          );

      return project(context, stored);
    },
    async link(
      context: TenantContext,
      kind: LinkableKind,
      targetId: string,
      otherId: string,
      reason: string,
    ) {
      requireRole(context, ['owner', 'admin']);
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
      requireRole(context, ['owner', 'admin']);
      const mappings = await sources.mappings(context, kind, entityId);
      const own = mappings.filter(
        (item) => item.source.connectionId === connectionId,
      );
      if (own.length && own.length === mappings.length)
        throw new LinkError('This record is not linked to another source');
      for (const item of own) {
        let target = await inventory.identify(
          context,
          kind,
          sourceLocalKey(item.source),
        );
        // The source may have been this record's origin; give it a new record instead.
        if (target === entityId)
          target = await inventory.identify(
            context,
            kind,
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
      await reproject(context, kind, entityId, connectionId, reason);

      return { moved: own.length };
    },
  };

  async function bind(
    context: TenantContext,
    source: SourceIdentity,
    reconciliationKey: string,
    observationId: string,
    method: string,
  ) {
    requireRole(context, ['owner', 'admin']);
    requireTenant(context, source.tenantId);
    if (source.resource === 'customer')
      throw new Error('Customer profiles have no canonical mapping');
    // The key is explicit operator evidence, never an inferred SKU or display number.
    const resource = source.resource;
    const id =
      resource === 'order' || resource === 'order_line'
        ? await orders.identify(context, resource, reconciliationKey)
        : resource === 'fulfillment' ||
            resource === 'return' ||
            resource === 'refund'
          ? // One source's operations; mirrored copies in other sources stay separate.
            await orders.identify(
              context,
              resource,
              JSON.stringify([source.connectionId, reconciliationKey]),
            )
          : await inventory.identify(context, resource, reconciliationKey);
    await sources.bind(context, source, id, observationId, method);

    return id;
  }

  /**
   * Re-projects current snapshots that still refer to `id` after its mappings changed, then
   * removes each source's projection from the record it no longer belongs to.
   */
  async function reproject(
    context: TenantContext,
    kind: LinkableKind,
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

      return project(context, stored);
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

export type LinkableKind = 'sku' | 'location';

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
