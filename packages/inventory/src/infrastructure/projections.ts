import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CanonicalSnapshot,
  CommerceProjections,
  Dependent,
} from '../application/projections.js';
import { refreshTransferProjection } from './transfer-projection.js';
import { snapshotSchema } from './validation.js';

/**
 * Creates tenant-scoped inventory entities and versioned canonical snapshots from validated
 * observations.
 */
export function createCommerceProjections(
  db: TenantDatabase,
): CommerceProjections {
  /** Applies one validated snapshot; the caller holds its entity lock. */
  async function apply(
    tx: SqlTransaction,
    context: TenantContext,
    value: CanonicalSnapshot,
  ): Promise<'applied' | 'retained' | 'duplicate'> {
    const tenant = context.tenantId;
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
      if (!same.rows[0]?.matches) throw new Error('Snapshot identity conflict');
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
      await refreshProductSkus(tx, tenant, [{ snapshotId: snapshot, value }]);
      await refreshTransferProjection(tx, tenant, [
        { snapshotId: snapshot, value },
      ]);

      return 'applied';
    }

    return (await applyNew(tx, context, [value]))[0]!;
  }

  /**
   * Applies new snapshots, at most one per entity and source, with one statement per step.
   * The caller holds their entity locks and has checked that none was stored before.
   */
  async function applyNew(
    tx: SqlTransaction,
    context: TenantContext,
    values: CanonicalSnapshot[],
  ): Promise<('applied' | 'retained')[]> {
    const tenant = context.tenantId;
    const refs = [
      ...new Map(
        values.flatMap(references).map((ref) => [`${ref.kind}:${ref.id}`, ref]),
      ).values(),
    ];
    const found = await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_entities e
      JOIN unnest($2::text[],$3::uuid[]) AS k(kind,id) ON e.tenant_id=$1 AND e.kind=k.kind AND e.id=k.id`,
      [tenant, refs.map((ref) => ref.kind), refs.map((ref) => ref.id)],
    );
    if (found.rows[0]!.count !== refs.length)
      throw new Error('Canonical relationship not found');
    const ids = values.map(() => randomUUID());
    await tx.query(
      `INSERT INTO inventory_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,source_updated_at,observed_at,document,mapping_version)
      SELECT r.id,$1,r.entity_id,r.kind,r.connection_id,r.observation_id,r.normalizer_version,r.source_updated_at,r.observed_at,r.document,r.mapping_version
      FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,entity_id uuid,kind text,connection_id uuid,observation_id uuid,
        normalizer_version text,source_updated_at timestamptz,observed_at timestamptz,document jsonb,mapping_version text)`,
      [
        tenant,
        JSON.stringify(
          values.map((value, index) => ({
            id: ids[index],
            entity_id: value.entityId,
            kind: value.kind,
            connection_id: value.connectionId,
            observation_id: value.observationId,
            normalizer_version: value.normalizerVersion,
            source_updated_at: value.sourceUpdatedAt,
            observed_at: value.observedAt,
            document: value,
            mapping_version: value.mappingVersion,
          })),
        ),
      ],
    );
    const current = new Map(
      (
        await tx.query<{
          entity_id: string;
          connection_id: string;
          document: CanonicalSnapshot;
        }>(
          `SELECT p.entity_id,p.connection_id,s.document FROM inventory_projections p
          JOIN unnest($2::uuid[],$3::uuid[]) AS k(entity_id,connection_id) ON p.tenant_id=$1 AND p.entity_id=k.entity_id AND p.connection_id=k.connection_id
          JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id`,
          [
            tenant,
            values.map((value) => value.entityId),
            values.map((value) => value.connectionId),
          ],
        )
      ).rows.map((row) => [
        `${row.entity_id}:${row.connection_id}`,
        row.document,
      ]),
    );
    const statuses = values.map((value) => {
      const existing = current.get(`${value.entityId}:${value.connectionId}`);

      return existing && !supersedes(value, existing)
        ? ('retained' as const)
        : ('applied' as const);
    });
    const applied = values
      .map((value, index) => ({ value, snapshotId: ids[index]! }))
      .filter((_, index) => statuses[index] === 'applied')
      .sort(
        (a, b) =>
          a.value.entityId.localeCompare(b.value.entityId) ||
          a.value.connectionId.localeCompare(b.value.connectionId),
      );
    if (applied.length) {
      await tx.query(
        `INSERT INTO inventory_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,connection_id,snapshot_id FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) AS k(entity_id,connection_id,snapshot_id)
        ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,version=inventory_projections.version+1,updated_at=now()`,
        [
          tenant,
          applied.map((item) => item.value.entityId),
          applied.map((item) => item.value.connectionId),
          applied.map((item) => item.snapshotId),
        ],
      );
      await tx.query(
        `INSERT INTO inventory_projection_events(id,tenant_id,snapshot_id,actor_id)
        SELECT gen_random_uuid(),$1,snapshot_id,$3 FROM unnest($2::uuid[]) AS snapshot_id`,
        [tenant, applied.map((item) => item.snapshotId), context.actor.id],
      );
      await refreshProductSkus(tx, tenant, applied);
      await refreshTransferProjection(tx, tenant, applied);
    }

    return statuses;
  }

  /**
   * Applies a batch in input order. New snapshots of distinct sources share set-based writes;
   * replays and repeated sources apply one at a time.
   */
  async function applyAll(
    tx: SqlTransaction,
    context: TenantContext,
    values: CanonicalSnapshot[],
  ): Promise<('applied' | 'retained' | 'duplicate')[]> {
    const sources = new Set(
      values.map((value) => `${value.entityId}:${value.connectionId}`),
    );
    if (sources.size === values.length) {
      const stored = await tx.query(
        `SELECT 1 FROM inventory_snapshots s JOIN unnest($2::uuid[],$3::uuid[],$4::text[],$5::text[])
          AS k(entity_id,observation_id,normalizer_version,mapping_version)
        ON s.tenant_id=$1 AND s.entity_id=k.entity_id AND s.observation_id=k.observation_id
          AND s.normalizer_version=k.normalizer_version AND s.mapping_version=k.mapping_version LIMIT 1`,
        [
          context.tenantId,
          values.map((value) => value.entityId),
          values.map((value) => value.observationId),
          values.map((value) => value.normalizerVersion),
          values.map((value) => value.mappingVersion),
        ],
      );
      if (!stored.rowCount) return applyNew(tx, context, values);
    }
    const statuses: ('applied' | 'retained' | 'duplicate')[] = [];
    for (const value of values) statuses.push(await apply(tx, context, value));

    return statuses;
  }

  async function projectMany(
    context: TenantContext,
    inputs: CanonicalSnapshot[],
  ) {
    requirePermission(context, 'sync.manage');
    const values = inputs.map(
      (input) => snapshotSchema.parse(input) as CanonicalSnapshot,
    );
    if (!values.length) return [];

    return db.transaction(context.tenantId, async (tx) => {
      // Sorted so concurrent batches touching the same entities cannot deadlock.
      await tx.query(
        `WITH ids AS MATERIALIZED (SELECT DISTINCT id FROM unnest($2::uuid[]) id ORDER BY id)
        SELECT pg_advisory_xact_lock(hashtextextended('inventory:' || $1 || ':' || id::text,0)) FROM ids`,
        [context.tenantId, values.map((value) => value.entityId)],
      );

      return applyAll(tx, context, values);
    });
  }

  return {
    async identify(context, kind, reconciliationKey) {
      requirePermission(context, 'sync.manage');
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
    async identifyMany(context, items) {
      requirePermission(context, 'sync.manage');
      for (const item of items)
        z.string().min(1).max(1024).parse(item.reconciliationKey);
      const found = new Map<string, string>();
      if (!items.length) return found;
      const kinds = items.map((item) => item.kind);
      const keys = items.map((item) => item.reconciliationKey);

      return db.transaction(context.tenantId, async (tx) => {
        // Sorted inserts keep concurrent imports of overlapping records from deadlocking.
        await tx.query(
          `INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key)
          SELECT gen_random_uuid(),$1,kind,key FROM (SELECT DISTINCT kind,key FROM unnest($2::text[],$3::text[]) AS k(kind,key)) k
          ORDER BY kind,key ON CONFLICT(tenant_id,kind,reconciliation_key) DO NOTHING`,
          [context.tenantId, kinds, keys],
        );
        const rows = await tx.query<{
          kind: string;
          reconciliation_key: string;
          id: string;
        }>(
          `SELECT e.kind,e.reconciliation_key,e.id FROM inventory_entities e
          JOIN unnest($2::text[],$3::text[]) AS k(kind,key) ON e.tenant_id=$1 AND e.kind=k.kind AND e.reconciliation_key=k.key`,
          [context.tenantId, kinds, keys],
        );
        for (const row of rows.rows)
          found.set(JSON.stringify([row.kind, row.reconciliation_key]), row.id);

        return found;
      });
    },
    async missing(context, kind, ids) {
      requireTenant(context, context.tenantId);
      const unique = [...new Set(ids)];
      if (!unique.length) return [];

      return db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ id: string }>(
            `SELECT k.id FROM unnest($3::uuid[]) AS k(id) WHERE NOT EXISTS (
              SELECT 1 FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind=$2 AND e.id=k.id)`,
            [context.tenantId, kind, unique],
          )
        ).rows.map((row) => row.id),
      );
    },
    async project(context, input) {
      return (await projectMany(context, [input]))[0]!;
    },
    projectMany,
    async dependents(context, kind, id, connectionId) {
      requireTenant(context, context.tenantId);
      z.string().uuid().parse(id);
      if (connectionId) z.string().uuid().parse(connectionId);

      return db.transaction(context.tenantId, async (tx) => {
        const column = kind === 'sku' ? 'sku_id' : 'location_id';
        const rows = await tx.query<Dependent>(
          `SELECT p.entity_id AS "entityId",'position' AS kind,p.connection_id AS "connectionId",s.observation_id AS "observationId"
          FROM inventory_snapshots s JOIN inventory_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
          WHERE s.tenant_id=$1 AND s.${column}=$2 AND s.kind='position' AND ($3::uuid IS NULL OR p.connection_id=$3)
          UNION ALL
          SELECT p.entity_id,'product',p.connection_id,s.observation_id
          FROM inventory_product_skus k
          JOIN inventory_projections p ON p.tenant_id=k.tenant_id AND p.entity_id=k.product_id AND p.connection_id=k.connection_id
          JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
          WHERE $4 AND k.tenant_id=$1 AND k.sku_id=$2 AND ($3::uuid IS NULL OR k.connection_id=$3)
          UNION
          SELECT k.product_id,'product',k.connection_id,s.observation_id
          FROM inventory_bundle_components k JOIN inventory_snapshots s ON s.tenant_id=k.tenant_id AND s.id=k.snapshot_id
          WHERE $4 AND k.tenant_id=$1 AND k.component_sku_id=$2 AND ($3::uuid IS NULL OR k.connection_id=$3)
          UNION ALL
          SELECT k.entity_id,s.kind,k.connection_id,s.observation_id
          FROM inventory_transfer_references k JOIN inventory_snapshots s ON s.tenant_id=k.tenant_id AND s.id=k.snapshot_id
          WHERE k.tenant_id=$1 AND k.resource=$5 AND k.canonical_id=$2 AND ($3::uuid IS NULL OR k.connection_id=$3)
          ORDER BY 1,3`,
          [context.tenantId, id, connectionId ?? null, kind === 'sku', kind],
        );

        return rows.rows;
      });
    },
    async retire(context, entityId, connectionId, reason) {
      requirePermission(context, 'sync.manage');
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
 * current observation always wins; a newer source update time wins; otherwise the later
 * observation time wins, so a second change within one whole-second update time still
 * advances. The greater observation ID breaks remaining ties unless exactly one snapshot
 * has an update time. Source-clock update times are never compared with Luma-clock
 * observation times.
 */
export function supersedes(
  incoming: SnapshotOrder,
  current: SnapshotOrder,
): boolean {
  if (incoming.observationId === current.observationId) return true;
  // Null when either snapshot lacks a source update time.
  const updated =
    incoming.sourceUpdatedAt && current.sourceUpdatedAt
      ? Date.parse(incoming.sourceUpdatedAt) -
        Date.parse(current.sourceUpdatedAt)
      : null;
  if (updated) return updated > 0;
  const observed =
    Date.parse(incoming.observedAt) - Date.parse(current.observedAt);
  if (observed !== 0) return observed > 0;

  return (
    (updated === 0 ||
      (!incoming.sourceUpdatedAt && !current.sourceUpdatedAt)) &&
    incoming.observationId > current.observationId
  );
}

function references(value: CanonicalSnapshot): { kind: string; id: string }[] {
  if (value.data.type === 'product')
    return value.data.skus.flatMap((sku) => [
      { kind: 'sku', id: sku.skuId },
      ...(sku.bundle?.components ?? []).flatMap((component) =>
        component.skuId ? [{ kind: 'sku', id: component.skuId }] : [],
      ),
    ]);
  if (
    value.data.type === 'inventory_transfer' ||
    value.data.type === 'inventory_shipment'
  ) {
    const refs = (value.data.lines ?? []).flatMap((line) =>
      line.skuId ? [{ kind: 'sku', id: line.skuId }] : [],
    );
    if (value.data.type === 'inventory_transfer') {
      for (const location of [value.data.origin, value.data.destination]) {
        if (location?.locationId)
          refs.push({ kind: 'location', id: location.locationId });
      }
    }

    return refs;
  }

  return [
    { kind: 'sku', id: value.data.skuId },
    { kind: 'location', id: value.data.locationId },
  ];
}

// Indexed product-to-SKU relations for the current source projections; JSON expression
// indexes are not usable under forced row-level security. Positions are skipped.
async function refreshProductSkus(
  tx: SqlTransaction,
  tenant: string,
  items: { snapshotId: string; value: CanonicalSnapshot }[],
) {
  const products = items.filter((item) => item.value.data.type === 'product');
  if (!products.length) return;
  await tx.query(
    `DELETE FROM inventory_product_skus k USING unnest($2::uuid[],$3::uuid[]) AS d(product_id,connection_id)
    WHERE k.tenant_id=$1 AND k.product_id=d.product_id AND k.connection_id=d.connection_id`,
    [
      tenant,
      products.map((item) => item.value.entityId),
      products.map((item) => item.value.connectionId),
    ],
  );
  const rows = products.flatMap(({ snapshotId, value }) => {
    if (value.deleted || value.data.type !== 'product') return [];
    const data = value.data;

    // Each row repeats the product's listing facts so catalog reads use plain columns.
    return data.skus.map((sku) => ({
      product_id: value.entityId,
      connection_id: value.connectionId,
      snapshot_id: snapshotId,
      product_title: data.title,
      product_status: data.status,
      vendor: data.vendor ?? null,
      published: data.published ?? null,
      observed_at: value.observedAt,
      source_updated_at: value.sourceUpdatedAt,
      sku_id: sku.skuId,
      code: sku.code,
      title: sku.title ?? null,
      barcode: sku.barcode ?? null,
      amount: sku.price?.amount ?? null,
      currency: sku.price?.currency ?? null,
      unit: sku.unit,
      requires_components: sku.bundle?.requiresComponents ?? null,
      component_count: sku.bundle?.components?.length ?? null,
      variant_source_id: sku.bundle?.variant.externalId ?? null,
    }));
  });
  if (!rows.length) return;
  await tx.query(
    `INSERT INTO inventory_product_skus(tenant_id,product_id,connection_id,sku_id,code,snapshot_id,
      product_title,product_status,vendor,published,variant_title,barcode,price_amount,price_currency,unit,
      observed_at,source_updated_at,requires_components,variant_source_id,component_count)
    SELECT DISTINCT ON (s.product_id,s.connection_id,s.sku_id) $1::uuid,s.product_id,s.connection_id,s.sku_id,s.code,
      s.snapshot_id,s.product_title,s.product_status,s.vendor,s.published,s.title,s.barcode,s.amount::numeric,s.currency,
      s.unit,s.observed_at,s.source_updated_at,s.requires_components,s.variant_source_id,s.component_count
    FROM jsonb_to_recordset($2::jsonb) AS s(product_id uuid,connection_id uuid,snapshot_id uuid,product_title text,
      product_status text,vendor text,published boolean,observed_at timestamptz,source_updated_at timestamptz,
      sku_id uuid,code text,title text,barcode text,amount text,currency text,unit text,requires_components boolean,variant_source_id text,component_count integer)
    ORDER BY s.product_id,s.connection_id,s.sku_id,s.code NULLS LAST`,
    [tenant, JSON.stringify(rows)],
  );
  const components = products.flatMap(({ snapshotId, value }) =>
    value.deleted || value.data.type !== 'product'
      ? []
      : value.data.skus.flatMap((sku) =>
          (sku.bundle?.components ?? []).map((component) => ({
            product_id: value.entityId,
            connection_id: value.connectionId,
            parent_sku_id: sku.skuId,
            snapshot_id: snapshotId,
            source_component_id: component.sourceId.externalId,
            source_scope_key: component.sourceId.scopeKey,
            component_sku_id: component.skuId,
          })),
        ),
  );
  if (components.length)
    await tx.query(
      `INSERT INTO inventory_bundle_components(tenant_id,product_id,connection_id,parent_sku_id,snapshot_id,source_component_id,source_scope_key,component_sku_id)
    SELECT $1,r.product_id,r.connection_id,r.parent_sku_id,r.snapshot_id,r.source_component_id,r.source_scope_key,r.component_sku_id
    FROM jsonb_to_recordset($2::jsonb) AS r(product_id uuid,connection_id uuid,parent_sku_id uuid,snapshot_id uuid,source_component_id text,source_scope_key text,component_sku_id uuid)`,
      [tenant, JSON.stringify(components)],
    );
}
