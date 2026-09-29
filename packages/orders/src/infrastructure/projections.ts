import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requireRole, requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CanonicalSnapshot,
  CommerceProjections,
} from '../application/projections.js';
import { snapshotSchema } from './validation.js';

/**
 * Creates tenant-scoped order and fulfillment projections, checking referenced SKUs through
 * the supplied lookup.
 */
export function createCommerceProjections(
  db: TenantDatabase,
  skuExists: (context: TenantContext, id: string) => Promise<boolean>,
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
          if (line.skuId && !(await skuExists(context, line.skuId)))
            throw new Error('Canonical SKU not found');
        }

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `orders:${tenant}:${value.entityId}`,
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

          return 'duplicate';
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
            : [value.entityId, ...value.data.lines.map((l) => l.orderLineId)];
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
        if (value.data.type === 'fulfillment') {
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
          if (
            value.data.lines.some(
              (line) =>
                !lines.some(
                  (p) => p.id === line.orderLineId && p.unit === line.unit,
                ),
            )
          )
            throw new Error('Fulfillment line or unit mismatch');
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
        ...value.data.lines.map((line) => ({
          kind: 'order_line',
          id: line.orderLineId,
        })),
      ];
}
