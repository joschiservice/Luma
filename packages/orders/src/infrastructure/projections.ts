import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  CanonicalSnapshot,
  CommerceProjections,
  Projection,
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
  inventoryMissing: (
    context: TenantContext,
    kind: 'sku' | 'location',
    ids: string[],
  ) => Promise<string[]>,
): CommerceProjections {
  /** Applies one validated snapshot; the caller holds its order lock and refreshes reads. */
  async function apply(
    tx: SqlTransaction,
    context: TenantContext,
    value: CanonicalSnapshot,
  ): Promise<'applied' | 'retained' | 'duplicate'> {
    const tenant = context.tenantId;
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
      if (!same.rows[0]?.matches) throw new Error('Snapshot identity conflict');
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

      return 'applied';
    }

    return (await applyNew(tx, context, [value]))[0]!;
  }

  /**
   * Applies new snapshots, at most one per entity and source, with one statement per step.
   * The caller holds their order locks and has checked that none was stored before.
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
      `SELECT count(*)::int AS count FROM orders_entities e
        JOIN unnest($2::text[],$3::uuid[]) AS k(kind,id) ON e.tenant_id=$1 AND e.kind=k.kind AND e.id=k.id`,
      [tenant, refs.map((ref) => ref.kind), refs.map((ref) => ref.id)],
    );
    if (found.rows[0]!.count !== refs.length)
      throw new Error('Canonical relationship not found');
    const relations = values
      .flatMap((value) =>
        childrenOf(value).map((child) => ({ child, order: orderOf(value) })),
      )
      .sort((a, b) => a.child.localeCompare(b.child));
    const children = relations.map((relation) => relation.child);
    const parents = relations.map((relation) => relation.order);
    await tx.query(
      `INSERT INTO orders_relationships(tenant_id,child_id,order_id)
        SELECT $1,child,parent FROM unnest($2::uuid[],$3::uuid[]) AS k(child,parent) ON CONFLICT DO NOTHING`,
      [tenant, children, parents],
    );
    const foreign = await tx.query(
      `SELECT 1 FROM orders_relationships r JOIN unnest($2::uuid[],$3::uuid[]) AS k(child,parent)
        ON r.tenant_id=$1 AND r.child_id=k.child WHERE r.order_id<>k.parent LIMIT 1`,
      [tenant, children, parents],
    );
    if (foreign.rowCount)
      throw new Error('Canonical child belongs to another order');
    const dependents = values.filter((value) => value.data.type !== 'order');
    const parentOrders = await currentDocuments(
      tx,
      tenant,
      dependents.map((value) => ({
        entityId: orderOf(value),
        connectionId: value.connectionId,
      })),
    );
    for (const value of dependents) {
      if (value.data.type === 'order') continue;
      const parent = parentOrders.get(
        `${orderOf(value)}:${value.connectionId}`,
      );
      if (!parent || parent.deleted || parent.data.type !== 'order')
        throw new Error('Order projection not found');
      const lines = parent.data.lines;
      if (
        value.data.lines.some(
          (line) =>
            line.orderLineId &&
            !lines.some(
              (p) => p.id === line.orderLineId && p.unit === line.unit,
            ),
        )
      )
        throw new Error(
          `${value.data.type === 'fulfillment' ? 'Fulfillment' : 'Return or refund'} line or unit mismatch`,
        );
    }
    const ids = values.map(() => randomUUID());
    await tx.query(
      `INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,source_updated_at,observed_at,document,mapping_version)
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
    const current = await currentDocuments(tx, tenant, values);
    const statuses = values.map((value) => {
      const existing = current.get(`${value.entityId}:${value.connectionId}`);

      return existing && !supersedes(value, existing)
        ? ('retained' as const)
        : ('applied' as const);
    });
    const applied = values
      .map((value, index) => ({ value, id: ids[index]! }))
      .filter((_, index) => statuses[index] === 'applied')
      .sort(
        (a, b) =>
          a.value.entityId.localeCompare(b.value.entityId) ||
          a.value.connectionId.localeCompare(b.value.connectionId),
      );
    if (applied.length) {
      await tx.query(
        `INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,connection_id,snapshot_id FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) AS k(entity_id,connection_id,snapshot_id)
        ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,version=orders_projections.version+1,updated_at=now()`,
        [
          tenant,
          applied.map((item) => item.value.entityId),
          applied.map((item) => item.value.connectionId),
          applied.map((item) => item.id),
        ],
      );
      await tx.query(
        `INSERT INTO orders_projection_events(id,tenant_id,snapshot_id,actor_id)
        SELECT gen_random_uuid(),$1,snapshot_id,$3 FROM unnest($2::uuid[]) AS snapshot_id`,
        [tenant, applied.map((item) => item.id), context.actor.id],
      );
    }

    return statuses;
  }

  /**
   * Applies a batch in input order. New snapshots of distinct sources share set-based writes;
   * replays, repeated sources and orders arriving with their children apply one at a time.
   */
  async function applyAll(
    tx: SqlTransaction,
    context: TenantContext,
    values: CanonicalSnapshot[],
  ): Promise<('applied' | 'retained' | 'duplicate')[]> {
    const sources = new Set(
      values.map((value) => `${value.entityId}:${value.connectionId}`),
    );
    const orders = values.filter((value) => value.data.type === 'order');
    if (
      sources.size === values.length &&
      (orders.length === 0 || orders.length === values.length)
    ) {
      const stored = await tx.query(
        `SELECT 1 FROM orders_snapshots s JOIN unnest($2::uuid[],$3::uuid[],$4::text[],$5::text[])
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
    const skus = values.flatMap((value) =>
      value.data.type === 'order'
        ? value.data.lines.flatMap((line) => (line.skuId ? [line.skuId] : []))
        : [],
    );
    if ((await inventoryMissing(context, 'sku', skus)).length)
      throw new Error('Canonical SKU not found');
    const locations = values.flatMap((value) =>
      value.data.type === 'fulfillment' && value.data.location?.locationId
        ? [value.data.location.locationId]
        : [],
    );
    if ((await inventoryMissing(context, 'location', locations)).length)
      throw new Error('Canonical location not found');

    return db.transaction(context.tenantId, async (tx) => {
      // Sorted, as in the list rebuilder, so concurrent batches cannot deadlock.
      await tx.query(
        `WITH ids AS MATERIALIZED (SELECT DISTINCT id FROM unnest($2::uuid[]) id ORDER BY id)
        SELECT pg_advisory_xact_lock(hashtextextended('orders:' || $1 || ':' || id::text,0)) FROM ids`,
        [context.tenantId, values.map(orderOf)],
      );
      const statuses = await applyAll(tx, context, values);
      await refresh(
        tx,
        context.tenantId,
        values.filter((_, index) => statuses[index] === 'applied'),
      );

      return statuses;
    });
  }

  return {
    async identify(context, kind, reconciliationKey) {
      requirePermission(context, 'sync.manage');
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
          `INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
          SELECT gen_random_uuid(),$1,kind,key FROM (SELECT DISTINCT kind,key FROM unnest($2::text[],$3::text[]) AS k(kind,key)) k
          ORDER BY kind,key ON CONFLICT(tenant_id,kind,reconciliation_key) DO NOTHING`,
          [context.tenantId, kinds, keys],
        );
        const rows = await tx.query<{
          kind: string;
          reconciliation_key: string;
          id: string;
        }>(
          `SELECT e.kind,e.reconciliation_key,e.id FROM orders_entities e
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
              SELECT 1 FROM orders_entities e WHERE e.tenant_id=$1 AND e.kind=$2 AND e.id=k.id)`,
            [context.tenantId, kind, unique],
          )
        ).rows.map((row) => row.id),
      );
    },
    async project(context, input) {
      return (await projectMany(context, [input]))[0]!;
    },
    projectMany,
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
    async currentMany(context, entityIds) {
      requireTenant(context, context.tenantId);
      const found = new Map<string, Projection[]>();
      const ids = [...new Set(entityIds)];
      if (!ids.length) return found;
      const rows = await db.transaction(context.tenantId, (tx) =>
        tx.query<{
          entityId: string;
          snapshotId: string;
          version: number;
          snapshot: CanonicalSnapshot;
        }>(
          `SELECT p.entity_id AS "entityId",s.id AS "snapshotId",p.version,s.document AS snapshot FROM orders_projections p
          JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
          WHERE p.tenant_id=$1 AND p.entity_id=ANY($2::uuid[]) ORDER BY p.entity_id,p.connection_id`,
          [context.tenantId, ids],
        ),
      );
      for (const { entityId, ...projection } of rows.rows)
        found.set(entityId, [...(found.get(entityId) ?? []), projection]);

      return found;
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
      requirePermission(context, 'sync.manage');
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
 * carry different source update times, the newer one wins; receipt order and opaque
 * revisions never count. Otherwise the later observation time wins, because every
 * observation records when its point-in-time read started on Luma's clock. This also
 * advances a second change within one update time, since providers such as Shopify report
 * whole seconds. Update times from the source's clock are never compared with observation
 * times. Equal observation times fall back to the greater observation ID unless exactly one
 * snapshot has an update time, so the same set of reads always settles on one snapshot.
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

/** The current snapshot document of each source, keyed by `entityId:connectionId`. */
async function currentDocuments(
  tx: SqlTransaction,
  tenant: string,
  sources: Pick<CanonicalSnapshot, 'entityId' | 'connectionId'>[],
) {
  const found = new Map<string, CanonicalSnapshot>();
  if (!sources.length) return found;
  const rows = await tx.query<{
    entity_id: string;
    connection_id: string;
    document: CanonicalSnapshot;
  }>(
    `SELECT p.entity_id,p.connection_id,s.document FROM orders_projections p
    JOIN unnest($2::uuid[],$3::uuid[]) AS k(entity_id,connection_id) ON p.tenant_id=$1 AND p.entity_id=k.entity_id AND p.connection_id=k.connection_id
    JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id`,
    [
      tenant,
      sources.map((source) => source.entityId),
      sources.map((source) => source.connectionId),
    ],
  );
  for (const row of rows.rows)
    found.set(`${row.entity_id}:${row.connection_id}`, row.document);

  return found;
}

/** Entities whose parent is the snapshot's order: its lines, or the child and its references. */
function childrenOf(value: CanonicalSnapshot): string[] {
  return value.data.type === 'order'
    ? value.data.lines.map((line) => line.id)
    : [
        value.entityId,
        ...lineIds(value),
        ...(value.data.type === 'refund' && value.data.returnId
          ? [value.data.returnId]
          : []),
      ];
}

const orderOf = (value: CanonicalSnapshot) =>
  value.data.type === 'order' ? value.entityId : value.data.orderId;

const sortedUnique = (ids: string[]) => [...new Set(ids)].sort();

/**
 * Rebuilds the maintained reads that depend on newly current snapshots once per batch, in
 * their transaction. The caller holds the order locks.
 */
async function refresh(
  tx: SqlTransaction,
  tenantId: string,
  values: CanonicalSnapshot[],
) {
  if (!values.length) return;
  await tx.query(
    'DELETE FROM orders_entity_redirects WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[])',
    [tenantId, sortedUnique(values.map((value) => value.entityId))],
  );
  const returns = (value: CanonicalSnapshot) =>
    value.data.type === 'return' || value.data.type === 'refund';
  for (const orderId of sortedUnique(values.filter(returns).map(orderOf))) {
    await refreshReturnList(tx, tenantId, orderId);
    // Share the case command fence: an imported return must not claim these units twice.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `orders-return-cases:${tenantId}:${orderId}`,
    ]);
    await tx.query(
      `UPDATE orders_return_cases c SET source_return_id=m.canonical_id,
      revision=c.revision+1,updated_at=now(),document=c.document || jsonb_build_object(
        'sourceReturnId',m.canonical_id,'revision',c.revision+1,'updatedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM orders_return_creations r JOIN connector_source_mappings m
        ON m.tenant_id=r.tenant_id AND m.connection_id=r.connection_id AND m.resource='return'
        AND m.external_id=r.document->'externalReturn'->>'externalId' AND m.scope_key=''
      JOIN orders_returns imported ON imported.tenant_id=m.tenant_id AND imported.connection_id=m.connection_id
        AND imported.entity_id=m.canonical_id AND imported.order_id=$2 AND NOT imported.deleted
      WHERE c.tenant_id=$1 AND c.order_id=$2 AND c.state='open' AND c.source_return_id IS NULL
        AND r.tenant_id=c.tenant_id AND r.case_id=c.id AND r.state='created'
        AND NOT EXISTS (SELECT 1 FROM orders_return_cases other WHERE other.tenant_id=c.tenant_id
          AND other.source_return_id=m.canonical_id AND other.state='open' AND other.id<>c.id)`,
      [tenantId, orderId],
    );
    await tx.query(
      `UPDATE orders_return_cases c SET source_return_id=m.canonical_id,
      revision=c.revision+1,updated_at=now(),document=c.document || jsonb_build_object(
        'sourceReturnId',m.canonical_id,'revision',c.revision+1,'updatedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM orders_return_exchanges x JOIN orders_return_exchange_steps s
        ON s.tenant_id=x.tenant_id AND s.operation_id=x.id AND s.id=(x.document->>'currentAttemptId')::uuid AND s.kind='request' AND s.state='verified'
      JOIN connector_source_mappings m ON m.tenant_id=s.tenant_id AND m.connection_id=(s.document->>'connectionId')::uuid
        AND m.resource='return' AND m.external_id=s.document->'proof'->>'returnId' AND m.scope_key=''
      JOIN orders_returns imported ON imported.tenant_id=m.tenant_id AND imported.connection_id=m.connection_id
        AND imported.entity_id=m.canonical_id AND imported.order_id=$2 AND NOT imported.deleted AND imported.status NOT IN ('cancelled','declined')
      WHERE c.tenant_id=$1 AND c.order_id=$2 AND c.state='open' AND x.tenant_id=c.tenant_id AND x.case_id=c.id
        AND x.document->'choice'='null'::jsonb AND c.source_return_id IS DISTINCT FROM m.canonical_id
        AND (c.source_return_id IS NULL OR EXISTS(SELECT 1 FROM orders_return_exchange_steps cancelled JOIN connector_source_mappings old
          ON old.tenant_id=cancelled.tenant_id AND old.connection_id=(cancelled.document->>'connectionId')::uuid AND old.resource='return'
          AND old.external_id=cancelled.document->'proof'->>'returnId' AND old.canonical_id=c.source_return_id
          WHERE cancelled.tenant_id=c.tenant_id AND cancelled.case_id=c.id AND cancelled.kind='cancel' AND cancelled.state='verified'))
        AND NOT EXISTS(SELECT 1 FROM orders_return_cases other WHERE other.tenant_id=c.tenant_id AND other.source_return_id=m.canonical_id AND other.state='open' AND other.id<>c.id)`,
      [tenantId, orderId],
    );
  }
  const listed = values.filter((value) => !returns(value));
  const orders = listed.filter((value) => value.data.type === 'order');
  const searched = sortedUnique(orders.map(orderOf));
  await refreshOrderList(tx, tenantId, searched);
  await refreshOrderList(
    tx,
    tenantId,
    sortedUnique(listed.map(orderOf)).filter((id) => !searched.includes(id)),
    false,
  );
  await refreshFulfillmentList(tx, tenantId, sortedUnique(listed.map(orderOf)));
  // Return rows show their order's number; the last applied snapshot of each source is current.
  const numbers = [
    ...new Map(
      orders.map((value) => [`${value.entityId}:${value.connectionId}`, value]),
    ).values(),
  ];
  if (numbers.length)
    await tx.query(
      `UPDATE orders_returns r SET order_number=u.number
      FROM unnest($2::uuid[],$3::uuid[],$4::text[]) AS u(order_id,connection_id,number)
      WHERE r.tenant_id=$1 AND r.order_id=u.order_id AND r.connection_id=u.connection_id
        AND r.order_number IS DISTINCT FROM u.number`,
      [
        tenantId,
        numbers.map((value) => value.entityId),
        numbers.map((value) => value.connectionId),
        numbers.map((value) =>
          value.data.type === 'order' ? value.data.displayNumber : null,
        ),
      ],
    );
}
