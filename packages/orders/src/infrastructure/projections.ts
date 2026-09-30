import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CanonicalSnapshot,
  CommerceProjections,
} from '../application/projections.js';
import { refreshFulfillmentList } from './fulfillment-list.js';
import { refreshOrderList } from './list-projection.js';
import { refreshReturnList } from './return-list.js';
import { snapshotSchema } from './validation.js';

/**
 * Creates tenant-scoped order, fulfillment, return and refund projections, checking referenced
 * SKUs and locations through the supplied inventory lookup.
 */
export function createCommerceProjections(
  db: TenantDatabase,
  inventoryExists: (
    context: TenantContext,
    kind: 'sku' | 'location',
    id: string,
  ) => Promise<boolean>,
): CommerceProjections {
  return {
    async identify(context, kind, reconciliationKey) {
      requireRole(context, ['owner', 'admin']);
      z.string().min(1).max(1024).parse(reconciliationKey);

      return db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ id: string }>(
          `INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,kind,reconciliation_key) DO NOTHING RETURNING id`,
          [randomUUID(), context.tenantId, kind, reconciliationKey],
        );

        return (
          result.rows[0]?.id ??
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM orders_entities WHERE tenant_id=$1 AND kind=$2 AND reconciliation_key=$3',
              [context.tenantId, kind, reconciliationKey],
            )
          ).rows[0]!.id
        );
      });
    },
    async has(context, kind, id) {
      requireTenant(context, context.tenantId);

      return db.transaction(context.tenantId, async (tx) =>
        Boolean(
          (
            await tx.query(
              'SELECT id FROM orders_entities WHERE tenant_id=$1 AND kind=$2 AND id=$3',
              [context.tenantId, kind, id],
            )
          ).rowCount,
        ),
      );
    },
    async project(context, input) {
      requireRole(context, ['owner', 'admin']);
      const value = snapshotSchema.parse(input) as CanonicalSnapshot;
      if (value.data.type === 'order')
        for (const line of value.data.lines) {
          if (
            line.skuId &&
            !(await inventoryExists(context, 'sku', line.skuId))
          )
            throw new Error('Canonical SKU not found');
        }
      const locationId =
        value.data.type === 'fulfillment'
          ? value.data.location?.locationId
          : null;
      if (
        locationId &&
        !(await inventoryExists(context, 'location', locationId))
      )
        throw new Error('Canonical location not found');

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `orders:${tenant}:${value.data.type === 'order' ? value.entityId : value.data.orderId}`,
        ]);
        const old = await tx.query<{ document: CanonicalSnapshot }>(
          'SELECT document FROM orders_snapshots WHERE tenant_id=$1 AND entity_id=$2 AND observation_id=$3 AND normalizer_version=$4 AND mapping_version=$5',
          [
            tenant,
            value.entityId,
            value.observationId,
            value.normalizerVersion,
            value.mappingVersion,
          ],
        );
        if (old.rows[0]) {
          const same = await tx.query<{ matches: boolean }>(
            'SELECT $1::jsonb=$2::jsonb AS matches',
            [old.rows[0].document, value],
          );
          if (!same.rows[0]?.matches)
            throw new Error('Snapshot identity conflict');
          // Replaying after a SKU link change can return to an earlier snapshot of the
          // current observation; make it current again.
          const restored = await tx.query<{ snapshot_id: string }>(
            `WITH existing AS (SELECT id FROM orders_snapshots WHERE tenant_id=$1 AND entity_id=$2
              AND observation_id=$4 AND normalizer_version=$5 AND mapping_version=$6)
            INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
            SELECT $1,$2,$3,id FROM existing
            ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
              version=orders_projections.version+1,updated_at=now()
            WHERE orders_projections.snapshot_id<>EXCLUDED.snapshot_id AND EXISTS (
              SELECT 1 FROM orders_snapshots c WHERE c.tenant_id=$1 AND c.id=orders_projections.snapshot_id
              AND c.observation_id=$4)
            RETURNING snapshot_id`,
            [
              tenant,
              value.entityId,
              value.connectionId,
              value.observationId,
              value.normalizerVersion,
              value.mappingVersion,
            ],
          );
          const snapshot = restored.rows[0]?.snapshot_id;
          if (!snapshot) return 'duplicate';
          await tx.query(
            'INSERT INTO orders_projection_events(id,tenant_id,snapshot_id,actor_id) VALUES($1,$2,$3,$4)',
            [randomUUID(), tenant, snapshot, context.actor.id],
          );
          await refresh(tx, tenant, value);

          return 'applied';
        }
        for (const ref of references(value)) {
          const found = await tx.query(
            'SELECT id FROM orders_entities WHERE tenant_id=$1 AND kind=$2 AND id=$3',
            [tenant, ref.kind, ref.id],
          );
          if (!found.rowCount)
            throw new Error('Canonical relationship not found');
        }
        const parentId =
          value.data.type === 'order' ? value.entityId : value.data.orderId;
        const children =
          value.data.type === 'order'
            ? value.data.lines.map((l) => l.id)
            : [
                value.entityId,
                ...lineIds(value),
                ...(value.data.type === 'refund' && value.data.returnId
                  ? [value.data.returnId]
                  : []),
              ];
        for (const child of children) {
          await tx.query(
            'INSERT INTO orders_relationships(tenant_id,child_id,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [tenant, child, parentId],
          );
          const parent = (
            await tx.query<{ order_id: string }>(
              'SELECT order_id FROM orders_relationships WHERE tenant_id=$1 AND child_id=$2',
              [tenant, child],
            )
          ).rows[0];
          if (parent?.order_id !== parentId)
            throw new Error('Canonical child belongs to another order');
        }
        if (value.data.type !== 'order') {
          const parent = (
            await tx.query<{ document: CanonicalSnapshot }>(
              `SELECT s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
             WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
              [tenant, parentId, value.connectionId],
            )
          ).rows[0]?.document;
          if (!parent || parent.deleted || parent.data.type !== 'order')
            throw new Error('Order projection not found');
          const lines = parent.data.lines;
          const units = value.data.lines.flatMap((line) =>
            line.orderLineId
              ? [{ orderLineId: line.orderLineId, unit: line.unit }]
              : [],
          );
          if (
            units.some(
              (line) =>
                !lines.some(
                  (p) => p.id === line.orderLineId && p.unit === line.unit,
                ),
            )
          )
            throw new Error(
              `${value.data.type === 'fulfillment' ? 'Fulfillment' : 'Return or refund'} line or unit mismatch`,
            );
        }
        const id = randomUUID();
        await tx.query(
          `INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,source_updated_at,observed_at,document,mapping_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            tenant,
            value.entityId,
            value.kind,
            value.connectionId,
            value.observationId,
            value.normalizerVersion,
            value.sourceUpdatedAt,
            value.observedAt,
            value,
            value.mappingVersion,
          ],
        );
        const current = (
          await tx.query<{ document: CanonicalSnapshot }>(
            `SELECT s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
      WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
            [tenant, value.entityId, value.connectionId],
          )
        ).rows[0]?.document;
        if (current && !supersedes(value, current)) return 'retained';
        await tx.query(
          `INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,version=orders_projections.version+1,updated_at=now()`,
          [tenant, value.entityId, value.connectionId, id],
        );
        await tx.query(
          'INSERT INTO orders_projection_events(id,tenant_id,snapshot_id,actor_id) VALUES($1,$2,$3,$4)',
          [randomUUID(), tenant, id, context.actor.id],
        );

        await refresh(tx, tenant, value);

        return 'applied';
      });
    },
    async current(context, entityId) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              snapshotId: string;
              version: number;
              snapshot: CanonicalSnapshot;
            }>(
              `SELECT s.id AS "snapshotId",p.version,s.document AS snapshot FROM orders_projections p
     JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
     WHERE p.tenant_id=$1 AND p.entity_id=$2 ORDER BY p.connection_id`,
              [context.tenantId, entityId],
            )
          ).rows,
      );
    },
    async childParent(context, childId) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ order_id: string }>(
              'SELECT order_id FROM orders_relationships WHERE tenant_id=$1 AND child_id=$2',
              [context.tenantId, childId],
            )
          ).rows[0]?.order_id ?? null,
      );
    },
    async orderDependents(context, orderId, connectionId) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              entityId: string;
              connectionId: string;
              observationId: string;
            }>(
              `SELECT p.entity_id AS "entityId",p.connection_id AS "connectionId",s.observation_id AS "observationId"
           FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
           WHERE p.tenant_id=$1 AND (p.entity_id=$2 OR s.order_id=$2)
             AND ($3::uuid IS NULL OR p.connection_id=$3)
           ORDER BY CASE s.kind WHEN 'order' THEN 0 WHEN 'fulfillment' THEN 1 WHEN 'return' THEN 2 ELSE 3 END,p.entity_id`,
              [context.tenantId, orderId, connectionId ?? null],
            )
          ).rows,
      );
    },
    async retire(context, entityId, connectionId, targetId, reason) {
      requireRole(context, ['owner', 'admin']);
      z.string().trim().min(1).max(2000).parse(reason);
      if (entityId === targetId)
        throw new Error('Cannot retire a record into itself');

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        const source = (
          await tx.query<{ document: CanonicalSnapshot }>(
            `SELECT s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
           WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
            [tenant, entityId, connectionId],
          )
        ).rows[0]?.document;
        if (!source) return false;
        const orderId =
          source.data.type === 'order' ? entityId : source.data.orderId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `orders:${tenant}:${orderId}`,
        ]);
        const target = await tx.query(
          `SELECT p.entity_id FROM orders_projections p JOIN orders_entities e ON e.tenant_id=p.tenant_id AND e.id=p.entity_id
           WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3 AND e.kind=$4`,
          [tenant, targetId, connectionId, source.kind],
        );
        if (!target.rowCount)
          throw new Error('Retirement target projection not found');
        const removed = await tx.query<{ snapshot_id: string }>(
          'DELETE FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3 RETURNING snapshot_id',
          [tenant, entityId, connectionId],
        );
        const snapshot = removed.rows[0]?.snapshot_id;
        if (!snapshot) return false;
        await tx.query(
          `INSERT INTO orders_projection_retirements(id,tenant_id,entity_id,connection_id,target_entity_id,snapshot_id,reason,actor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            tenant,
            entityId,
            connectionId,
            targetId,
            snapshot,
            reason,
            context.actor.id,
          ],
        );
        await tx.query(
          `INSERT INTO orders_entity_redirects(tenant_id,entity_id,target_entity_id)
          SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2)
          ON CONFLICT(tenant_id,entity_id) DO UPDATE SET target_entity_id=EXCLUDED.target_entity_id`,
          [tenant, entityId, targetId],
        );
        await refreshOrderList(tx, tenant, [orderId]);
        await refreshFulfillmentList(tx, tenant, [orderId]);
        await refreshReturnList(tx, tenant, orderId);

        return true;
      });
    },
    async skuDependents(context, skuId, connectionId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(skuId);
      if (connectionId) z.string().uuid().parse(connectionId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              entityId: string;
              connectionId: string;
              observationId: string;
            }>(
              `SELECT k.entity_id AS "entityId",k.connection_id AS "connectionId",s.observation_id AS "observationId"
              FROM orders_list_skus k
              JOIN orders_projections p ON p.tenant_id=k.tenant_id AND p.entity_id=k.entity_id AND p.connection_id=k.connection_id
              JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
              WHERE k.tenant_id=$1 AND k.sku_id=$2 AND ($3::uuid IS NULL OR k.connection_id=$3)
              ORDER BY k.entity_id,k.connection_id`,
              [context.tenantId, skuId, connectionId ?? null],
            )
          ).rows,
      );
    },
    async locationDependents(context, locationId, connectionId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(locationId);
      if (connectionId) z.string().uuid().parse(connectionId);

      return db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{
              entityId: string;
              connectionId: string;
              observationId: string;
            }>(
              `SELECT f.entity_id AS "entityId",f.connection_id AS "connectionId",s.observation_id AS "observationId"
              FROM orders_fulfillment_list f
              JOIN orders_snapshots s ON s.tenant_id=f.tenant_id AND s.id=f.snapshot_id
              WHERE f.tenant_id=$1 AND f.location_id=$2 AND ($3::uuid IS NULL OR f.connection_id=$3)
              ORDER BY f.entity_id,f.connection_id`,
              [context.tenantId, locationId, connectionId ?? null],
            )
          ).rows,
      );
    },
    async history(context, entityId) {
      requireTenant(context, context.tenantId);

      return db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: CanonicalSnapshot }>(
            'SELECT document FROM orders_snapshots WHERE tenant_id=$1 AND entity_id=$2 ORDER BY created_at,id',
            [context.tenantId, entityId],
          )
        ).rows.map((row) => row.document),
      );
    },
  };
}

type SnapshotOrder = Pick<
  CanonicalSnapshot,
  'observationId' | 'sourceUpdatedAt' | 'observedAt'
>;

/**
 * Decides whether `incoming` replaces `current` as its source's current snapshot.
 *
 * A re-normalized copy of the current observation always replaces it. When both snapshots
 * carry a source update time, only a strictly newer time wins; receipt order and opaque
 * revisions never count. Otherwise the later observation time wins, because every
 * observation records when its point-in-time read started on Luma's clock. Update times
 * from the source's clock are never compared with observation times. Equal observation
 * times fall back to the greater observation ID only when neither snapshot has an update
 * time, so the same set of untimed snapshots always settles on the same current one.
 */
export function supersedes(
  incoming: SnapshotOrder,
  current: SnapshotOrder,
): boolean {
  if (incoming.observationId === current.observationId) return true;
  if (incoming.sourceUpdatedAt && current.sourceUpdatedAt)
    return (
      Date.parse(incoming.sourceUpdatedAt) > Date.parse(current.sourceUpdatedAt)
    );
  const observed =
    Date.parse(incoming.observedAt) - Date.parse(current.observedAt);
  if (observed !== 0) return observed > 0;

  return (
    !incoming.sourceUpdatedAt &&
    !current.sourceUpdatedAt &&
    incoming.observationId > current.observationId
  );
}

function references(value: CanonicalSnapshot): { kind: string; id: string }[] {
  return value.data.type === 'order'
    ? value.data.lines.map((line) => ({ kind: 'order_line', id: line.id }))
    : [
        { kind: 'order', id: value.data.orderId },
        ...lineIds(value).map((id) => ({ kind: 'order_line', id })),
        ...(value.data.type === 'refund' && value.data.returnId
          ? [{ kind: 'return', id: value.data.returnId }]
          : []),
      ];
}

/** Order lines a child record refers to; return lines without an order line are skipped. */
function lineIds(value: CanonicalSnapshot): string[] {
  if (value.data.type === 'order') return [];
  const ids: string[] = [];
  for (const line of value.data.lines)
    if (line.orderLineId) ids.push(line.orderLineId);

  return [...new Set(ids)];
}

/** Rebuilds the maintained reads that depend on a newly current snapshot, in its transaction. */
async function refresh(
  tx: SqlTransaction,
  tenantId: string,
  value: CanonicalSnapshot,
) {
  await tx.query(
    'DELETE FROM orders_entity_redirects WHERE tenant_id=$1 AND entity_id=$2',
    [tenantId, value.entityId],
  );
  if (value.data.type === 'return' || value.data.type === 'refund') {
    await refreshReturnList(tx, tenantId, value.data.orderId);

    return;
  }
  const orderId =
    value.data.type === 'order' ? value.entityId : value.data.orderId;
  await refreshOrderList(tx, tenantId, [orderId], value.data.type === 'order');
  await refreshFulfillmentList(tx, tenantId, [orderId]);
  // Return rows show their order's number; keep it current when the order changes.
  if (value.data.type === 'order')
    await tx.query(
      `UPDATE orders_returns SET order_number=$4 WHERE tenant_id=$1 AND order_id=$2 AND connection_id=$3
       AND order_number IS DISTINCT FROM $4`,
      [tenantId, value.entityId, value.connectionId, value.data.displayNumber],
    );
}
