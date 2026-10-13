import { createHash } from 'node:crypto';

import { hasPermission, requirePermission } from '@luma/identity';
import { receivingSignals } from '@luma/inventory';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  TransferDetail,
  TransferQuery,
  TransferSummary,
  TransferWorkspace,
} from '../../application/transfers.js';

const cursorSchema = z
  .object({
    context: z.string(),
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

type Row = Omit<TransferSummary, 'evidence' | 'signals'> & {
  available: boolean;
};

const rows = `SELECT r.entity_id AS id,r.connection_id AS "connectionId",r.kind,r.name,r.status,r.snapshot_id AS "snapshotId",r.observed_at::text AS "observedAt",r.facts,
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

/** Builds indexed operational lists and exact-source details in a consistent, tenant-scoped read snapshot. */
export function createTransferWorkspace(
  db: TenantDatabase,
  now = () => new Date(),
): TransferWorkspace {
  return {
    async listTransfers(context, query) {
      requirePermission(context, 'inventory.read');
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'transfers/1',
            context.tenantId,
            query.kind,
            query.q,
            query.connectionId,
            query.skuId,
            query.locationId,
          ]),
        )
        .digest('hex');
      let after: z.infer<typeof cursorSchema> | null = null;
      if (query.cursor) {
        try {
          const bytes = Buffer.from(query.cursor, 'base64url');
          if (bytes.toString('base64url') !== query.cursor)
            throw new Error('Encoding');
          after = cursorSchema.parse(JSON.parse(bytes.toString()));
          if (after.context !== scope) throw new Error('Scope');
        } catch {
          throw Object.assign(
            new Error(
              'This page link no longer matches the transfer filters. Start from the first page.',
            ),
            { statusCode: 400, expose: true },
          );
        }
      }
      const at = now();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '4000ms'");
          const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
          const result = await tx.query<Row>(
            `${rows}
          WHERE r.tenant_id=$1 AND r.kind=$2 AND NOT r.deleted
          AND ($3::text='' OR r.name ILIKE $4)
          AND ($5::uuid IS NULL OR r.connection_id=$5)
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM inventory_transfer_references f WHERE f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id AND f.resource='sku' AND f.canonical_id=$6))
          AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM inventory_transfer_references f WHERE f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id AND f.resource='location' AND f.canonical_id=$7))
          AND ($8::uuid IS NULL OR (r.entity_id,r.connection_id)>($8::uuid,$9::uuid))
          ORDER BY r.entity_id,r.connection_id LIMIT 51`,
            [
              context.tenantId,
              query.kind,
              query.q,
              pattern,
              query.connectionId ?? null,
              query.skuId ?? null,
              query.locationId ?? null,
              after?.id ?? null,
              after?.connectionId ?? null,
            ],
          );
          const last = result.rows[49];

          return {
            items: result.rows.slice(0, 50).map((row) => summary(row, at)),
            nextCursor:
              result.rows.length > 50 && last
                ? Buffer.from(
                    JSON.stringify({
                      context: scope,
                      id: last.id,
                      connectionId: last.connectionId,
                    }),
                  ).toString('base64url')
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
            `${rows} WHERE r.tenant_id=$1 AND r.entity_id=$2 AND r.connection_id=$3`,
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
            `${rows} JOIN connector_source_mappings m ON m.tenant_id=r.tenant_id AND m.connection_id=r.connection_id AND m.resource='inventory_shipment' AND m.canonical_id=r.entity_id
          JOIN inventory_transfer_shipments f ON f.tenant_id=m.tenant_id AND f.connection_id=m.connection_id AND f.shipment_source_id=m.external_id AND f.shipment_scope_key=m.scope_key
          WHERE f.tenant_id=$1 AND f.entity_id=$2 AND f.connection_id=$3 AND NOT r.deleted ORDER BY r.entity_id LIMIT 51`,
            [context.tenantId, id, connectionId],
          );
          const transfers = await tx.query<Row>(
            `${rows} JOIN inventory_transfer_shipments f ON f.tenant_id=r.tenant_id AND f.entity_id=r.entity_id AND f.connection_id=r.connection_id
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
