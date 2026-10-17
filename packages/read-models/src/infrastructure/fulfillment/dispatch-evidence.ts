import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import { resolveOrderEntity } from '../orders/identity-references.js';

const dispatch = z.object({
  entityId: z.string().uuid(),
  observationId: z.string().uuid(),
  observedAt: z.string().datetime(),
  deleted: z.boolean(),
  data: z.object({
    type: z.literal('fulfillment'),
    orderId: z.string().uuid(),
    kind: z.literal('shipment'),
    status: z.string(),
    shipping: z.object({
      stage: z.enum([
        'carrier',
        'delivered',
        'merchant',
        'warehouse',
        'unknown',
      ]),
    }),
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
    tracking: z.array(
      z.object({
        carrier: z.string().nullable(),
        number: z.string().nullable(),
        url: z.string().nullable(),
      }),
    ),
  }),
});

/**
 * Reads actual dispatched shipment evidence through exact canonical identities. It refreshes the
 * order's sources when the host supplies a refresh callback; missing mappings or ambiguous lines
 * never become publishable quantities. Requires order and fulfillment read permissions.
 */
export function createShipmentDispatchReader(
  database: TenantDatabase,
  refreshOrder?: (
    context: TenantContext,
    orderId: string,
    maxAgeMs: number,
  ) => Promise<void>,
) {
  return async (
    context: TenantContext,
    input: {
      connectionId: string;
      orderId: string;
      downstreamConnectionId: string;
      shipmentId: string;
    },
  ) => {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'orders.read');
    requirePermission(context, 'fulfillment.read');
    const resolve = () =>
      database.transaction(context.tenantId, async (tx) => {
        const rows = (
          await tx.query<{ id: string }>(
            `SELECT DISTINCT canonical_id::text AS id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND scope_key='' AND external_id=$3`,
            [context.tenantId, input.connectionId, input.orderId],
          )
        ).rows;

        return rows.length === 1
          ? resolveOrderEntity(tx, context.tenantId, rows[0]!.id)
          : null;
      });
    const orderId = await resolve();
    if (!orderId) return null;
    await refreshOrder?.(context, orderId, 0);

    return database.transaction(
      context.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        const rows = (
          await tx.query<{
            snapshotId: string;
            document: unknown;
            sourceOrder: unknown;
          }>(
            `SELECT s.id::text AS "snapshotId",s.document,o.document->'observation'->'data'->'order' AS "sourceOrder" FROM connector_source_mappings m JOIN orders_projections p ON p.tenant_id=m.tenant_id AND p.entity_id=m.canonical_id AND p.connection_id=m.connection_id JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.id=(s.document->>'observationId')::uuid WHERE m.tenant_id=$1 AND m.connection_id=$2 AND m.resource='fulfillment' AND m.external_id=$3 AND s.kind='fulfillment' AND s.order_id=$4`,
            [
              context.tenantId,
              input.downstreamConnectionId,
              input.shipmentId,
              orderId,
            ],
          )
        ).rows;
        if (rows.length !== 1) return null;
        const parsed = dispatch.safeParse(rows[0]!.document);
        if (!parsed.success) return null;
        const sourceOrder = z
          .object({ externalId: z.string(), scopeKey: z.string() })
          .safeParse(rows[0]!.sourceOrder);
        if (!sourceOrder.success) return null;
        const value = parsed.data;
        if (
          value.deleted ||
          !['shipped', 'delivered', 'completed'].includes(value.data.status) ||
          !['carrier', 'delivered'].includes(value.data.shipping.stage) ||
          !value.data.tracking.length
        )
          return null;
        const age = Date.now() - Date.parse(value.observedAt);
        if (age < 0 || age > 300_000) return null;
        const checks = (
          await tx.query<{ complete: boolean }>(
            `SELECT complete AND $5::uuid=ANY(observation_ids) AS complete FROM connector_order_read_checks WHERE tenant_id=$1 AND connection_id=$2 AND capability='fulfillment.read' AND order_external_id=$3 AND order_scope_key=$4 ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1`,
            [
              context.tenantId,
              input.downstreamConnectionId,
              sourceOrder.data.externalId,
              sourceOrder.data.scopeKey,
              value.observationId,
            ],
          )
        ).rows;
        if (checks[0]?.complete !== true) return null;
        const ids = value.data.lines.map((l) => l.orderLineId);
        const mappings = (
          await tx.query<{
            canonical_id: string;
            external_id: string;
            resource: string;
          }>(
            `SELECT canonical_id::text,external_id,resource FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND ((resource='order_line' AND canonical_id=ANY($3::uuid[]) AND scope_key=$5) OR (resource='location' AND canonical_id=$4::uuid AND scope_key=''))`,
            [
              context.tenantId,
              input.connectionId,
              ids,
              value.data.location?.locationId ?? null,
              input.orderId,
            ],
          )
        ).rows;
        const lines = [];
        for (const line of value.data.lines) {
          const matches = mappings.filter(
            (m) =>
              m.resource === 'order_line' &&
              m.canonical_id === line.orderLineId,
          );
          if (
            matches.length !== 1 ||
            !/^gid:\/\/shopify\/LineItem\/[0-9]+$/.test(
              matches[0]!.external_id,
            ) ||
            line.unit !== 'each' ||
            !/^[0-9]+(?:\.0+)?$/.test(line.quantity)
          )
            return null;
          const quantity = Number(line.quantity);
          if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
          lines.push({ orderLineId: matches[0]!.external_id, quantity });
        }
        const locations = mappings.filter((m) => m.resource === 'location');
        if (
          locations.length > 1 ||
          (locations.length === 1 &&
            !/^gid:\/\/shopify\/Location\/[0-9]+$/.test(
              locations[0]!.external_id,
            ))
        )
          return null;
        const tracking = [];
        for (const entry of value.data.tracking) {
          if (!entry.number || !entry.carrier) return null;
          if (entry.url) {
            try {
              if (new URL(entry.url).protocol !== 'https:') return null;
            } catch {
              return null;
            }
          }
          tracking.push({
            company: entry.carrier,
            number: entry.number,
            url: entry.url,
          });
        }
        const facts = {
          connectionId: input.downstreamConnectionId,
          shipmentId: input.shipmentId,
          stage:
            value.data.shipping.stage === 'delivered'
              ? ('delivered' as const)
              : ('carrier' as const),
          locationId: locations[0]?.external_id ?? null,
          lines,
          tracking,
        };

        return {
          id: rows[0]!.snapshotId,
          observationId: value.observationId,
          observedAt: value.observedAt,
          complete: true,
          revision: createHash('sha256')
            .update(canonicalJson(facts))
            .digest('hex'),
          ...facts,
        };
      },
      { readOnlySnapshot: true },
    );
  };
}

/** Lists bounded downstream parcels linked by the exact canonical order identity; no label implies an eligible allocation. */
export function createShipmentDispatchOptionsReader(database: TenantDatabase) {
  return async (
    context: TenantContext,
    input: { connectionId: string; orderId: string },
  ) => {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'orders.read');
    requirePermission(context, 'fulfillment.read');

    return database.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{
            downstreamConnectionId: string;
            shipmentId: string;
            label: string;
          }>(
            `
   WITH target AS (SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND scope_key='' AND external_id=$3)
   SELECT DISTINCT m.connection_id::text AS "downstreamConnectionId",m.external_id AS "shipmentId",concat(c.document->>'label',' · ',COALESCE(s.document#>>'{data,tracking,0,number}',m.external_id)) AS label
   FROM target t JOIN orders_snapshots s ON s.tenant_id=$1 AND s.order_id=t.canonical_id AND s.kind='fulfillment'
   JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
   JOIN connector_source_mappings m ON m.tenant_id=p.tenant_id AND m.canonical_id=p.entity_id AND m.connection_id=p.connection_id AND m.resource='fulfillment'
   JOIN connector_installations c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id
   WHERE (SELECT count(*) FROM target)=1 AND c.document->>'appId'='starshipit' AND c.document->>'status'='active' AND s.document->'data'->>'kind'='shipment' AND NOT (s.document->>'deleted')::boolean
   ORDER BY "downstreamConnectionId","shipmentId" LIMIT 50`,
            [context.tenantId, input.connectionId, input.orderId],
          )
        ).rows,
      { readOnlySnapshot: true },
    );
  };
}
