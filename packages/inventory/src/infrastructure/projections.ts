import { randomUUID } from 'node:crypto';

import { requireRole, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CanonicalSnapshot,
  CommerceProjections,
  Dependent,
} from '../application/projections.js';
import { snapshotSchema } from './validation.js';

/**
 * Creates tenant-scoped inventory entities and versioned canonical snapshots from validated
 * observations.
 */
export function createCommerceProjections(
  db: TenantDatabase,
): CommerceProjections {
  return {
    async identify(context, kind, reconciliationKey) {
      requireRole(context, ['owner', 'admin']);
      z.string().min(1).max(1024).parse(reconciliationKey);

      return db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query<{ id: string }>(
          `INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,kind,reconciliation_key) DO NOTHING RETURNING id`,
          [randomUUID(), context.tenantId, kind, reconciliationKey],
        );

        return (
          result.rows[0]?.id ??
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind=$2 AND reconciliation_key=$3',
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
              'SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind=$2 AND id=$3',
              [context.tenantId, kind, id],
            )
          ).rowCount,
        ),
      );
    },
    async project(context, input) {
      requireRole(context, ['owner', 'admin']);
      const value = snapshotSchema.parse(input) as CanonicalSnapshot;

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `inventory:${tenant}:${value.entityId}`,
        ]);
        const old = await tx.query<{ document: CanonicalSnapshot }>(
          'SELECT document FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2 AND observation_id=$3 AND normalizer_version=$4 AND mapping_version=$5',
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
          // Replaying after a link change can return to an earlier snapshot of the current
          // observation, or to an entity whose projection was retired; make it current again.
          const restored = await tx.query<{ snapshot_id: string }>(
            `WITH existing AS (SELECT id FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2
              AND observation_id=$4 AND normalizer_version=$5 AND mapping_version=$6)
            INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id)
            SELECT $1,$2,$3,id FROM existing
            ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
              version=inventory_projections.version+1,updated_at=now()
            WHERE inventory_projections.snapshot_id<>EXCLUDED.snapshot_id AND EXISTS (
              SELECT 1 FROM inventory_snapshots c WHERE c.tenant_id=$1 AND c.id=inventory_projections.snapshot_id
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
            'INSERT INTO inventory_projection_events(id,tenant_id,snapshot_id,actor_id) VALUES($1,$2,$3,$4)',
            [randomUUID(), tenant, snapshot, context.actor.id],
          );
          if (value.data.type === 'product')
            await refreshProductSkus(
              tx,
              tenant,
              value.entityId,
              value.connectionId,
              snapshot,
              value,
            );

          return 'applied';
        }
        for (const ref of references(value)) {
          const found = await tx.query(
            'SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind=$2 AND id=$3',
            [tenant, ref.kind, ref.id],
          );
          if (!found.rowCount)
            throw new Error('Canonical relationship not found');
        }
        const id = randomUUID();
        await tx.query(
          `INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,source_updated_at,observed_at,document,mapping_version)
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
            `SELECT s.document FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
      WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
            [tenant, value.entityId, value.connectionId],
          )
        ).rows[0]?.document;
        if (current && !supersedes(value, current)) return 'retained';
        await tx.query(
          `INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,version=inventory_projections.version+1,updated_at=now()`,
          [tenant, value.entityId, value.connectionId, id],
        );
        await tx.query(
          'INSERT INTO inventory_projection_events(id,tenant_id,snapshot_id,actor_id) VALUES($1,$2,$3,$4)',
          [randomUUID(), tenant, id, context.actor.id],
        );
        if (value.data.type === 'product')
          await refreshProductSkus(
            tx,
            tenant,
            value.entityId,
            value.connectionId,
            id,
            value,
          );

        return 'applied';
      });
    },
    async dependents(context, kind, id, connectionId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(id);
      if (connectionId) z.string().uuid().parse(connectionId);

      return db.transaction(context.tenantId, async (tx) => {
        const column = kind === 'sku' ? 'sku_id' : 'location_id';
        const rows = await tx.query<Dependent>(
          `SELECT p.entity_id AS "entityId",'position' AS kind,p.connection_id AS "connectionId",s.observation_id AS "observationId"
          FROM inventory_snapshots s JOIN inventory_projections p ON p.tenant_id=s.tenant_id AND p.snapshot_id=s.id
          WHERE s.tenant_id=$1 AND s.${column}=$2 AND s.kind='position' AND ($3::uuid IS NULL OR p.connection_id=$3)
          UNION ALL
          SELECT p.entity_id,'product',p.connection_id,s.observation_id
          FROM inventory_product_skus k
          JOIN inventory_projections p ON p.tenant_id=k.tenant_id AND p.entity_id=k.product_id AND p.connection_id=k.connection_id
          JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
          WHERE $4 AND k.tenant_id=$1 AND k.sku_id=$2 AND ($3::uuid IS NULL OR k.connection_id=$3)
          ORDER BY 1,3`,
          [context.tenantId, id, connectionId ?? null, kind === 'sku'],
        );

        return rows.rows;
      });
    },
    async retire(context, entityId, connectionId, reason) {
      requireRole(context, ['owner', 'admin']);
      z.string().uuid().parse(entityId);
      z.string().uuid().parse(connectionId);
      z.string().min(1).max(2000).parse(reason);

      return db.transaction(context.tenantId, async (tx) => {
        const tenant = context.tenantId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `inventory:${tenant}:${entityId}`,
        ]);
        const removed = await tx.query<{ snapshot_id: string }>(
          'DELETE FROM inventory_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3 RETURNING snapshot_id',
          [tenant, entityId, connectionId],
        );
        const snapshot = removed.rows[0]?.snapshot_id;
        if (!snapshot) return false;
        await tx.query(
          'DELETE FROM inventory_product_skus WHERE tenant_id=$1 AND product_id=$2 AND connection_id=$3',
          [tenant, entityId, connectionId],
        );
        await tx.query(
          `INSERT INTO inventory_projection_retirements(id,tenant_id,entity_id,connection_id,snapshot_id,reason,actor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            tenant,
            entityId,
            connectionId,
            snapshot,
            reason,
            context.actor.id,
          ],
        );

        return true;
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
              `SELECT s.id AS "snapshotId",p.version,s.document AS snapshot FROM inventory_projections p
     JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
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
            'SELECT document FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2 ORDER BY created_at,id',
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
 * Applies the same ordering policy as order projections: a re-normalized copy of the
 * current observation always wins; two source update times compare strictly; otherwise
 * the later observation time wins, with the greater observation ID breaking ties only
 * between snapshots that both lack an update time. Source-clock update times are never
 * compared with Luma-clock observation times.
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
  if (value.data.type === 'product')
    return value.data.skus.map((sku) => ({ kind: 'sku', id: sku.skuId }));

  return [
    { kind: 'sku', id: value.data.skuId },
    { kind: 'location', id: value.data.locationId },
  ];
}

// Indexed product-to-SKU relations for the current source projection; JSON expression
// indexes are not usable under forced row-level security.
async function refreshProductSkus(
  tx: SqlTransaction,
  tenant: string,
  productId: string,
  connectionId: string,
  snapshotId: string,
  value: CanonicalSnapshot,
) {
  await tx.query(
    'DELETE FROM inventory_product_skus WHERE tenant_id=$1 AND product_id=$2 AND connection_id=$3',
    [tenant, productId, connectionId],
  );
  if (value.deleted || value.data.type !== 'product') return;
  const data = value.data;
  // Each row repeats the product's listing facts so catalog reads use plain columns.
  await tx.query(
    `INSERT INTO inventory_product_skus(tenant_id,product_id,connection_id,sku_id,code,snapshot_id,
      product_title,product_status,vendor,published,variant_title,barcode,price_amount,price_currency,unit,
      observed_at,source_updated_at)
    SELECT DISTINCT ON (s.sku_id) $1::uuid,$2::uuid,$3::uuid,s.sku_id,s.code,$4::uuid,$5,$6,$7,$8,
      s.title,s.barcode,s.amount::numeric,s.currency,s.unit,$9::timestamptz,$10::timestamptz
    FROM jsonb_to_recordset($11::jsonb)
      AS s(sku_id uuid,code text,title text,barcode text,amount text,currency text,unit text)
    ORDER BY s.sku_id,s.code NULLS LAST`,
    [
      tenant,
      productId,
      connectionId,
      snapshotId,
      data.title,
      data.status,
      data.vendor ?? null,
      data.published ?? null,
      value.observedAt,
      value.sourceUpdatedAt,
      JSON.stringify(
        data.skus.map((sku) => ({
          sku_id: sku.skuId,
          code: sku.code,
          title: sku.title ?? null,
          barcode: sku.barcode ?? null,
          amount: sku.price?.amount ?? null,
          currency: sku.price?.currency ?? null,
          unit: sku.unit,
        })),
      ),
    ],
  );
}
