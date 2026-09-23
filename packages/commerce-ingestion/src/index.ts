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

    async function resolve(
      resource: SourceIdentity['resource'],
      external: ExternalId,
    ) {
      const source = { ...o.source, ...external, resource };
      const id = await sources.resolve(context, source);
      if (!id) missing.push(source);

      return id;
    }

    const provenance = {
      schemaVersion: 1 as const,
      connectionId: o.source.connectionId,
      observationId: o.id,
      normalizerVersion: 'commerce/1',
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
    if (input.capability === 'orders.read') {
      const entityId = await resolve('order', o.source);
      const data = input.observation.data;
      const lines = [];
      for (const line of data.lines) {
        const id = await resolve('order_line', line.id);
        // An unknown SKU does not prevent storing order facts.
        const skuId = line.sku
          ? await sources.resolve(context, {
              ...o.source,
              ...line.sku,
              resource: 'sku',
            })
          : null;
        if (id)
          lines.push({
            id,
            skuId,
            quantity: line.quantity.amount,
            cancelledQuantity: line.cancelledQuantity?.amount ?? null,
            unit: line.quantity.unit,
          });
      }
      if (!entityId || missing.length) return { status: 'pending', missing };
      const status = await orders.project(context, {
        ...provenance,
        entityId,
        kind: 'order',
        mappingVersion: digest(
          JSON.stringify([entityId, lines.map((l) => [l.id, l.skuId])]),
        ),
        data: {
          type: 'order',
          displayNumber: data.displayNumber,
          status: data.status,
          paymentStatus: data.paymentStatus,
          lines,
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
    const status = await orders.project(context, {
      ...provenance,
      entityId,
      kind: 'fulfillment',
      mappingVersion: digest(
        JSON.stringify([entityId, orderId, lines.map((l) => l.orderLineId)]),
      ),
      data: {
        type: 'fulfillment',
        orderId,
        status: data.status,
        lastProgressAt: data.lastProgressAt,
        failureCode: data.failureCode,
        lines,
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
    async bind(
      context: TenantContext,
      source: SourceIdentity,
      reconciliationKey: string,
      observationId: string,
      method: string,
    ) {
      requireRole(context, ['owner', 'admin']);
      requireTenant(context, source.tenantId);
      // The key is explicit operator evidence, never an inferred SKU or display number.
      const id =
        source.resource === 'order' ||
        source.resource === 'order_line' ||
        source.resource === 'fulfillment'
          ? await orders.identify(
              context,
              source.resource,
              source.resource === 'fulfillment'
                ? JSON.stringify([source.connectionId, reconciliationKey])
                : reconciliationKey,
            )
          : await inventory.identify(
              context,
              source.resource,
              reconciliationKey,
            );
      await sources.bind(context, source, id, observationId, method);

      return id;
    },
  };
}
