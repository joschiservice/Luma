import { hasPermission, requirePermission } from '@luma/identity';
import { receivingSignals } from '@luma/inventory';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  TransferDetail,
  TransferQuery,
  TransferSummary,
  TransferWorkspace,
} from '../../application/transfers.js';
import { collectionCursorContext } from '../collection/cursor.js';
import { likePattern } from '../collection/parameters.js';
import { collectionContext } from '../collection/request.js';
import { type CollectionFieldMap, compileWhere } from '../collection/where.js';
import {
  listKeyset,
  type ListPosition,
  positionOf,
  readListCursor,
  writeListCursor,
} from '../list-paging.js';

/** Sort values; records without one come last. */
const transferSortKeys = {
  requested: 'r.source_created_at',
  name: 'lower(r.name)',
  updated: 'u.source_updated_at',
} as const;

/** The source's last change, read from the current snapshot. */
const updatedJoin = `LEFT JOIN LATERAL (SELECT (s.document->>'sourceUpdatedAt')::timestamptz AS source_updated_at
 FROM inventory_snapshots s WHERE s.tenant_id=r.tenant_id AND s.id=r.snapshot_id) u ON true`;

type Row = Omit<TransferSummary, 'evidence' | 'signals'> & {
  available: boolean;
};

/** Selects summary rows `r`; `extra` adds columns. */
const rows = (
  extra = '',
) => `SELECT ${extra} r.entity_id AS id,r.connection_id AS "connectionId",r.kind,r.name,r.status,r.snapshot_id AS "snapshotId",r.observed_at::text AS "observedAt",r.facts,
 COALESCE(c.document->>'label','Shopify') AS label,
 (c.document->>'status'='active' AND c.document->'permissions' ? CASE WHEN r.kind='inventory_transfer' THEN 'inventory.transfers.read' ELSE 'inventory.shipments.read' END
 AND c.document->'granted' ? CASE WHEN r.kind='inventory_transfer' THEN 'inventory.transfers.read' ELSE 'inventory.shipments.read' END) AS available
 FROM inventory_transfer_records r LEFT JOIN connector_installations c ON c.tenant_id=r.tenant_id AND c.id=r.connection_id`;

function summary(row: Row, now: Date, deleted = false): TransferSummary {
  const { available, ...item } = row;
  const observedAt = new Date(row.observedAt).toISOString();
  const age = now.getTime() - Date.parse(observedAt);
  const evidence = !available
    ? 'unavailable'
    : age < 0 || age > 300_000
      ? 'stale'
      : deleted
        ? 'removed'
        : !row.facts.complete
          ? 'incomplete'
          : 'fresh';

  return {
    ...item,
    facts: deleted
      ? {
          ...item.facts,
          requested: null,
          received: null,
          shipped: null,
          unreceived: null,
          rejected: null,
          complete: false,
          consistent: false,
        }
      : item.facts,
    observedAt,
    evidence,
    signals: receivingSignals(
      row.facts,
      row.kind,
      row.status,
      observedAt,
      now,
      available && !deleted,
    ),
  };
}

/** Facts `r.facts` reports as decimal text; unknown quantities are null. */
const quantity = (name: string) => ({
  type: 'number' as const,
  sql: `(r.facts->>'${name}')::numeric`,
});

/** Transfers catalog fields as SQL over the record row `r` and its update time `u`. */
const transferFields: CollectionFieldMap = {
  source: { type: 'reference', sql: 'r.connection_id', cast: 'uuid' },
  requested: quantity('requested'),
  shipped: quantity('shipped'),
  received: quantity('received'),
  unreceived: quantity('unreceived'),
  requestedAt: { type: 'date', sql: 'r.source_created_at' },
  updated: { type: 'date', sql: 'u.source_updated_at', requires: ['updated'] },
};

/**
 * Reads up to `limit` + 1 current, non-removed transfer summaries of one kind in the requested
 * order after `after`, with the exact match count when the query asks for it. Throws a 400
 * error for invalid conditions.
 */
async function readTransferPage(
  tx: SqlTransaction,
  tenantId: string,
  query: TransferQuery,
  after: ListPosition | null,
  options: { userId: string; asOf: string },
) {
  const sort = query.sort ?? 'requested';
  const direction = query.direction ?? 'desc';
  const limit = query.limit ?? 50;
  const values: unknown[] = [
    tenantId,
    query.kind,
    query.q,
    likePattern(query.q),
    query.connectionId ?? null,
    query.skuId ?? null,
    query.locationId ?? null,
  ];
  const where = query.where?.conditions.length
    ? compileWhere(
        query.where,
        transferFields,
        collectionContext(values, options.asOf, query.timeZone, options.userId),
      )
    : { sql: 'true', requires: new Set<string>() };
  const filterValues = values.length;
  const joins =
    sort === 'updated' || where.requires.has('updated') ? updatedJoin : '';
  const filters = `r.tenant_id=$1 AND r.kind=$2 AND NOT r.deleted
  AND ($3::text='' OR r.name ILIKE $4)
  AND ($5::uuid IS NULL OR r.connection_id=$5)
  AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM inventory_transfer_references f WHERE f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id AND f.resource='sku' AND f.canonical_id=$6))
  AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM inventory_transfer_references f WHERE f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id AND f.resource='location' AND f.canonical_id=$7))
  AND ${where.sql}`;
  const order = listKeyset(
    {
      keys: [
        {
          sql: transferSortKeys[sort],
          type: sort === 'name' ? 'text' : 'timestamptz',
        },
      ],
      ids: ['r.entity_id', 'r.connection_id'],
      direction,
      // Every record has a name.
      ...(sort === 'name' ? { missing: false as const } : {}),
    },
    after,
    values,
  );
  values.push(limit + 1);
  const result = await tx.query<
    Row & { list_rank: boolean; list_keys: string[] | null }
  >(
    `${rows(`${order.position},`)} ${joins}
  WHERE ${filters} AND ${order.predicate}
  ORDER BY ${order.orderBy} LIMIT $${values.length}`,
    values,
  );
  const count =
    query.count === 'exact'
      ? (
          await tx.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM inventory_transfer_records r ${where.requires.has('updated') ? updatedJoin : ''} WHERE ${filters}`,
            values.slice(0, filterValues),
          )
        ).rows[0]!.count
      : null;

  return {
    rows: result.rows.map(({ list_rank, list_keys, ...item }) => ({
      item,
      position: positionOf({ list_rank, list_keys }, [
        item.id,
        item.connectionId,
      ]),
    })),
    totalCount: count,
  };
}

/** Builds indexed operational lists and exact-source details in a consistent, tenant-scoped read snapshot. */
export function createTransferWorkspace(
  db: TenantDatabase,
  now = () => new Date(),
): TransferWorkspace {
  return {
    async listTransfers(context, query) {
      requirePermission(context, 'inventory.read');
      const limit = query.limit ?? 50;
      // Bound to the tenant and every filter, condition and sort; page sizes may change.
      const scope = collectionCursorContext('transfers-v3', context.tenantId, {
        ...query,
        sort: query.sort ?? 'requested',
        direction: query.direction ?? 'desc',
        limit: undefined,
        count: undefined,
        cursor: undefined,
      });
      const after = query.cursor
        ? readListCursor(query.cursor, scope, 'transfer')
        : null;
      const at = now();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '4000ms'");
          const { rows: found, totalCount } = await readTransferPage(
            tx,
            context.tenantId,
            query,
            after,
            { userId: context.actor.id, asOf: at.toISOString() },
          );
          const page = found.slice(0, limit);
          const last = page.at(-1);

          return {
            items: page.map((row) => summary(row.item, at)),
            totalCount,
            nextCursor:
              found.length > limit && last
                ? writeListCursor(scope, last.position)
                : null,
            asOf: at.toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async getTransfer(context, id, connectionId) {
      requirePermission(context, 'inventory.read');
      const at = now();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '4000ms'");
          const result = await tx.query<Row>(
            `${rows()} WHERE r.tenant_id=$1 AND r.entity_id=$2 AND r.connection_id=$3`,
            [context.tenantId, id, connectionId],
          );
          const row = result.rows[0];
          if (!row) return null;
          const snapshot = await tx.query<{
            data: TransferDetail['data'];
            deleted: boolean;
            provenance: TransferDetail['provenance'];
          }>(
            `SELECT document->'data' AS data,(document->>'deleted')::boolean AS deleted,jsonb_build_object('observationId',document->>'observationId','sourceRevision',document->'sourceRevision','sourceUpdatedAt',document->'sourceUpdatedAt') AS provenance FROM inventory_snapshots WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId, row.snapshotId],
          );
          const current = snapshot.rows[0];
          if (!current) return null;
          const data = current.data;
          const sourceRows = await tx.query<{
            externalId: string;
            scopeKey: string;
          }>(
            `SELECT o.document->'observation'->'source'->>'externalId' AS "externalId",o.document->'observation'->'source'->>'scopeKey' AS "scopeKey"
          FROM inventory_snapshots s JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.connection_id=s.connection_id AND o.id=s.observation_id
          WHERE s.tenant_id=$1 AND s.id=$2`,
            [context.tenantId, row.snapshotId],
          );
          const source = sourceRows.rows[0] ?? null;
          const shipments = await tx.query<Row>(
            `${rows()} JOIN connector_source_mappings m ON m.tenant_id=r.tenant_id AND m.connection_id=r.connection_id AND m.resource='inventory_shipment' AND m.canonical_id=r.entity_id
          JOIN inventory_transfer_shipments f ON f.tenant_id=m.tenant_id AND f.connection_id=m.connection_id AND f.shipment_source_id=m.external_id AND f.shipment_scope_key=m.scope_key
          WHERE f.tenant_id=$1 AND f.entity_id=$2 AND f.connection_id=$3 AND NOT r.deleted ORDER BY r.entity_id LIMIT 51`,
            [context.tenantId, id, connectionId],
          );
          const transfers = await tx.query<Row>(
            `${rows()} JOIN inventory_transfer_shipments f ON f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id
          JOIN connector_source_mappings m ON m.tenant_id=f.tenant_id AND m.connection_id=f.connection_id AND m.resource='inventory_shipment' AND m.external_id=f.shipment_source_id AND m.scope_key=f.shipment_scope_key
          WHERE m.tenant_id=$1 AND m.canonical_id=$2 AND m.connection_id=$3 AND NOT r.deleted ORDER BY r.entity_id LIMIT 51`,
            [context.tenantId, id, connectionId],
          );
          const history = await tx.query<TransferDetail['history'][number]>(
            `SELECT id AS "snapshotId",document->>'observedAt' AS "observedAt",(document->>'deleted')::boolean AS deleted,
             document->'data'->>'name' AS name,document->'data'->>'status' AS status,CASE WHEN (document->>'deleted')::boolean THEN NULL ELSE document->'data'->>'receivedQuantity' END AS "receivedQuantity",document->'data'->'origin' AS origin,document->'data'->'destination' AS destination
             FROM inventory_snapshots WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3 ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 21`,
            [context.tenantId, id, connectionId],
          );
          const allowed = hasPermission(context, 'procurement.read');
          const purchaseOrders =
            allowed && source
              ? await procurement(
                  tx,
                  context.tenantId,
                  connectionId,
                  source.externalId,
                  row.kind,
                )
              : [];

          return {
            record: summary(
              current.deleted
                ? {
                    ...row,
                    name:
                      history.rows.find((entry) => !entry.deleted)?.name ??
                      row.name,
                  }
                : row,
              at,
              current.deleted,
            ),
            provenance: current.provenance,
            deleted: current.deleted,
            data: current.deleted ? null : data,
            source,
            shipments: unique(shipments.rows)
              .slice(0, 50)
              .map((item) => summary(item, at)),
            transfers: unique(transfers.rows)
              .slice(0, 50)
              .map((item) => summary(item, at)),
            history: history.rows.slice(0, 20),
            purchaseOrders: purchaseOrders.slice(0, 50),
            hidden: allowed ? [] : ['purchaseOrders'],
            relatedTruncated:
              shipments.rows.length > 50 ||
              transfers.rows.length > 50 ||
              history.rows.length > 20 ||
              purchaseOrders.length > 50,
            asOf: at.toISOString(),
          } satisfies TransferDetail;
        },
        { readOnlySnapshot: true },
      );
    },
  };
}

function unique(rows: Row[]) {
  return [
    ...new Map(
      rows.map((row) => [`${row.id}/${row.connectionId}`, row]),
    ).values(),
  ];
}

async function procurement(
  tx: SqlTransaction,
  tenantId: string,
  connectionId: string,
  externalId: string,
  kind: TransferQuery['kind'],
): Promise<TransferDetail['purchaseOrders']> {
  const result = await tx.query<TransferDetail['purchaseOrders'][number]>(
    `SELECT p.id,p.document->>'reference' AS label,p.document->>'status' AS status
    FROM procurement_transfer_links ref JOIN procurement_purchase_orders p ON p.tenant_id=ref.tenant_id AND p.id=ref.purchase_order_id
    WHERE ref.tenant_id=$1 AND ref.resource=$2 AND ref.external_id=$3 AND ref.connection_id=$4
    ORDER BY p.id LIMIT 51`,
    [tenantId, kind, externalId, connectionId],
  );

  return result.rows;
}
