import { createHash, randomUUID } from 'node:crypto';

import type { CapabilityOutput, CapabilityReader } from '@luma/connections';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  NativeStockStore,
  ShipmentRead,
} from '../application/native-stock.js';
import { LedgerError } from '../domain/ledger.js';
import { shipmentReadSchema } from './native-stock-validation.js';

interface ShipmentReaderDependencies {
  db: TenantDatabase;
  store: NativeStockStore;
  reader: CapabilityReader;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Connections and Orders validate and retain these observations through their owner ingestion path. */
  record(
    context: TenantContext,
    observations: CapabilityOutput<'fulfillment.read'>['items'],
  ): Promise<void>;
}

const normalized = z.object({
  data: z.object({
    type: z.literal('fulfillment'),
    orderId: z.string().uuid(),
    kind: z.string().nullable().optional(),
    status: z.string(),
    location: z
      .object({ locationId: z.string().uuid().nullable() })
      .nullable()
      .optional(),
    lines: z.array(
      z.object({
        orderLineId: z.string().uuid(),
        quantity: z.string(),
        unit: z.string(),
      }),
    ),
  }),
});

/** Independently reads one exact provider order and records canonical shipment evidence; no stock is dispatched. */
export function createNativeShipmentReader(deps: ShipmentReaderDependencies) {
  return async (
    context: TenantContext,
    orderId: string,
    connectionId: string,
  ): Promise<ShipmentRead> => {
    z.string().uuid().parse(orderId);
    z.string().uuid().parse(connectionId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'inventory.manage');
    requirePermission(fresh, 'orders.read');
    requirePermission(fresh, 'fulfillment.read');
    requirePermission(fresh, 'sync.manage');
    requireChangesAllowed(fresh);
    const references = await deps.db.transaction(fresh.tenantId, (tx) =>
      tx.query<{ external_id: string; scope_key: string }>(
        "SELECT external_id,scope_key FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND canonical_id=$3 ORDER BY external_id,scope_key LIMIT 2",
        [fresh.tenantId, connectionId, orderId],
      ),
    );
    if (references.rows.length !== 1)
      throw new LedgerError(
        'source_incomplete',
        'Select one exact source order before verifying shipments.',
      );
    const reference = references.rows[0]!,
      observedAt = new Date().toISOString();
    const result = await deps.reader.read(fresh, {
      connectionId,
      capability: 'fulfillment.read',
      version: '0',
      input: {
        limit: 100,
        order: {
          externalId: reference.external_id,
          scopeKey: reference.scope_key,
        },
      },
    });
    if (!result.ok)
      throw new LedgerError(
        'source_incomplete',
        `Shipment read failed: ${result.error.code}`,
      );
    if (
      result.value.nextCursor !== null ||
      result.value.completeness !== 'complete' ||
      result.value.items.length > 5000
    )
      throw new LedgerError(
        'source_incomplete',
        'This order did not return one complete bounded shipment read.',
      );
    await deps.record(fresh, result.value.items);
    const proof = await deps.db.transaction(fresh.tenantId, async (tx) => {
      await tx.query(
        'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
        [`commerce-ingestion:${fresh.tenantId}`],
      );
      const requested = [
        {
          resource: 'order',
          externalId: reference.external_id,
          scopeKey: reference.scope_key,
        },
      ];
      const shipments: ShipmentRead['shipments'] = [];
      for (const item of result.value.items) {
        requested.push({
          resource: 'fulfillment',
          externalId: item.source.externalId,
          scopeKey: item.source.scopeKey,
        });
        for (const line of item.data.lines)
          requested.push({
            resource: 'order_line',
            externalId: line.orderLine.externalId,
            scopeKey: line.orderLine.scopeKey,
          });
        if (item.data.location)
          requested.push({
            resource: 'location',
            externalId: item.data.location.id.externalId,
            scopeKey: item.data.location.id.scopeKey,
          });
        if (item.data.kind !== 'shipment') continue;
        const snapshots = (
          await tx.query<{ id: string; document: unknown }>(
            "SELECT id,document FROM orders_snapshots WHERE tenant_id=$1 AND connection_id=$2 AND observation_id=$3 AND kind='fulfillment' LIMIT 2",
            [fresh.tenantId, connectionId, item.id],
          )
        ).rows;
        if (snapshots.length !== 1)
          throw new LedgerError(
            'source_incomplete',
            'Shipment observation lacks one canonical snapshot.',
          );
        const snapshot = snapshots[0]!,
          data = normalized.parse(snapshot.document).data;
        if (data.orderId !== orderId)
          throw new LedgerError('stale', 'Shipment order mapping changed.');
        const status =
          data.status === 'shipped' ||
          data.status === 'delivered' ||
          data.status === 'cancelled'
            ? data.status
            : data.status === 'pending' || data.status === 'processing'
              ? 'pending'
              : 'unknown';
        shipments.push({
          id: item.source.externalId,
          snapshotId: snapshot.id,
          observationId: item.id,
          locationId: data.location?.locationId ?? null,
          status,
          lines: data.lines,
        });
      }
      const unique = [
        ...new Map(
          requested.map((reference) => [canonicalJson(reference), reference]),
        ).values(),
      ];
      const bindings = (
        await tx.query<ShipmentRead['bindings'][number]>(
          `SELECT m.id AS "mappingId",m.resource,m.external_id AS "externalId",m.scope_key AS "scopeKey",m.canonical_id AS "canonicalId" FROM connector_source_mappings m
    JOIN jsonb_to_recordset($3::jsonb) AS r(resource text,"externalId" text,"scopeKey" text) ON r.resource=m.resource AND r."externalId"=m.external_id AND r."scopeKey"=m.scope_key WHERE m.tenant_id=$1 AND m.connection_id=$2 ORDER BY m.id`,
          [fresh.tenantId, connectionId, JSON.stringify(unique)],
        )
      ).rows;
      if (bindings.length !== unique.length)
        throw new LedgerError(
          'source_incomplete',
          'Shipment references are incompletely mapped.',
        );

      return shipmentReadSchema.parse({
        id: randomUUID(),
        connectionId,
        orderId,
        orderExternalId: reference.external_id,
        orderScopeKey: reference.scope_key,
        observedAt,
        complete: true,
        mappingVersion: createHash('sha256')
          .update(canonicalJson(bindings))
          .digest('hex'),
        bindings,
        shipments,
      });
    });
    await deps.store.transaction(fresh, async (tx) => {
      await tx.lockOrder(orderId);
      await tx.saveShipmentRead(proof);
    });

    return proof;
  };
}
