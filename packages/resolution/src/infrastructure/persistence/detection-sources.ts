import type { FulfillmentSnapshot, Observation } from '@luma/connections';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type {
  DetectionSources,
  PositionSource,
  StockSource,
} from '../../application/detection-monitor.js';
import type { OrderSourceReader } from '../../application/order-refresh.js';

// Cross-domain reads for scheduled detection. Sync streams, installations, source mappings,
// stock projections and fulfillment projections are read here and never written.

const capabilities = {
  orders: 'orders.read',
  fulfillments: 'fulfillment.read',
  products: 'products.read',
  inventory: 'inventory.read',
} as const;

const time = z.coerce.date().transform((value) => value.toISOString());
const external = z.object({ externalId: z.string(), scopeKey: z.string() });

const streamRow = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string(),
  recordType: z.enum(['orders', 'fulfillments', 'products', 'inventory']),
  active: z.boolean(),
  accessLostAt: time.nullable(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  errorAt: time.nullable(),
  failingSince: time.nullable(),
  lastCompleteAt: time.nullable(),
});

const positionRow = z.object({
  nativeOwned: z.boolean().optional(),
  positionId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string(),
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  mappings: z.array(
    external.extend({
      id: z.string().uuid(),
      resource: z.enum(['sku', 'location']),
      createdAt: time,
    }),
  ),
});

const fulfillmentRow = z.object({
  fulfillmentId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string(),
  snapshotId: z.string().uuid(),
  observedAt: time,
  observation: z.object({
    source: z.object({
      tenantId: z.string(),
      connectionId: z.string(),
      provider: z.string(),
      resource: z.literal('fulfillment'),
      externalId: z.string(),
      scopeKey: z.string(),
    }),
    data: z.object({
      order: external,
      lines: z.array(z.object({ orderLine: external })),
    }),
  }),
});

// Installations whose current grant allows the read; the app must also still be installed.
const readable = (capability: string) => `c.document->>'status'='active'
 AND c.document->'permissions' ? '${capability}' AND c.document->'granted' ? '${capability}'
 AND EXISTS(SELECT 1 FROM workspace_apps a WHERE a.tenant_id=c.tenant_id AND a.app_id=c.document->>'appId'
  AND a.status='installed' AND a.version=(c.document->>'appInstallationVersion')::int)`;

const orderSourceRow = z.object({
  connectionId: z.string().uuid(),
  provider: z.string(),
  externalId: z.string(),
  scopeKey: z.string(),
  observedAt: time,
  fulfillments: z.boolean(),
  // Stored observations passed validation when they were imported.
  stored: z.array(z.custom<Observation<FulfillmentSnapshot>>()),
});

/** Creates tenant-scoped reads of the stored state that scheduled detection starts from. */
export function createDetectionSources(
  db: TenantDatabase,
): DetectionSources & OrderSourceReader {
  /** Keeps a source only when it has exactly one SKU and one location mapping. */
  function exactSource(row: z.infer<typeof positionRow>): StockSource | null {
    const sku = row.mappings.filter((m) => m.resource === 'sku');
    const location = row.mappings.filter((m) => m.resource === 'location');
    if (sku.length !== 1 || location.length !== 1) return null;

    return {
      connectionId: row.connectionId,
      provider: row.provider,
      sku: { externalId: sku[0]!.externalId, scopeKey: sku[0]!.scopeKey },
      location: {
        externalId: location[0]!.externalId,
        scopeKey: location[0]!.scopeKey,
      },
      mappedAt: [sku[0]!.createdAt, location[0]!.createdAt].sort().at(-1)!,
      mappingIds: [sku[0]!.id, location[0]!.id],
    };
  }

  return {
    async positionSources(context, positionId) {
      const rows = await db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `SELECT p.entity_id AS "positionId",p.connection_id AS "connectionId",c.document->>'provider' AS provider,
            s.document->'data'->>'skuId' AS "skuId",s.document->'data'->>'locationId' AS "locationId",
            s.observed_at AS "observedAt",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'resource',m.resource,'externalId',m.external_id,
              'scopeKey',m.scope_key,'createdAt',m.created_at) ORDER BY m.id)
             FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.connection_id=p.connection_id
              AND ((m.resource='sku' AND m.canonical_id=(s.document->'data'->>'skuId')::uuid)
               OR (m.resource='location' AND m.canonical_id=(s.document->'data'->>'locationId')::uuid))),'[]'::jsonb) AS mappings
          FROM inventory_projections p
          JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
          JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
          WHERE p.tenant_id=$1 AND p.entity_id=$2 AND s.kind='position'
           AND NOT (s.document->>'deleted')::boolean AND ${readable('inventory.read')}
          ORDER BY p.connection_id`,
          [context.tenantId, positionId],
        );

        return z
          .array(positionRow.extend({ observedAt: time }))
          .parse(result.rows);
      });

      return rows.flatMap((row): PositionSource[] => {
        const source = exactSource(row);

        return source ? [{ ...source, observedAt: row.observedAt }] : [];
      });
    },
    async streams(context) {
      return db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `SELECT s.id,s.connection_id AS "connectionId",c.document->>'provider' AS provider,
            s.record_type AS "recordType",
            (NOT s.paused AND s.blocked IS NULL AND c.document->>'status'='active') AS active,
            CASE WHEN c.document->>'status' IN ('revoked','degraded') AND b.status='active' THEN
             (SELECT min(l.created_at) FROM connector_lifecycle_events l
              WHERE l.tenant_id=c.tenant_id AND l.connection_id=c.id AND l.version>b.version)
            END AS "accessLostAt",
            s.attempts,s.error_code AS "errorCode",s.error_at AS "errorAt",
            s.failing_since AS "failingSince",s.last_complete_at AS "lastCompleteAt"
          FROM commerce_sync_streams s
          JOIN connector_installations c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
          -- Access is lost when the last working state was active, not a person's disconnect.
          -- Only providers set revoked or degraded; the loss starts with the first change after it.
          LEFT JOIN LATERAL (SELECT version,status FROM connector_lifecycle_events
            WHERE tenant_id=c.tenant_id AND connection_id=c.id
             AND (status='active' OR event IN ('disconnected','revoked','app_uninstalled'))
            ORDER BY version DESC LIMIT 1) b ON true
          WHERE s.tenant_id=$1 AND s.record_type IN ('orders','fulfillments','products','inventory')
          ORDER BY s.connection_id,s.record_type`,
          [context.tenantId],
        );

        return z
          .array(streamRow)
          .parse(result.rows)
          .map(({ recordType, ...stream }) => ({
            ...stream,
            capability: capabilities[recordType],
          }));
      });
    },
    async stockPositions(context, { include, limit }) {
      const named = include.map((item) => `${item.skuId}/${item.locationId}`);
      const rows = await db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `WITH current AS MATERIALIZED (
            SELECT p.entity_id,p.connection_id,c.document->>'provider' AS provider,
             s.document->'data'->>'skuId' AS sku_id,s.document->'data'->>'locationId' AS location_id,
             s.document->'data'->>'available' AS available,s.observed_at
            FROM inventory_projections p
            JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
            JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
            WHERE p.tenant_id=$1 AND s.kind='position' AND NOT (s.document->>'deleted')::boolean
             AND ${readable('inventory.read')}
          ), selected AS (
            SELECT entity_id,bool_or(sku_id||'/'||location_id=ANY($2::text[])) AS named,max(observed_at) AS latest
            FROM current GROUP BY entity_id
            HAVING count(*)>1 AND (count(DISTINCT available)>1 OR bool_or(sku_id||'/'||location_id=ANY($2::text[])))
            ORDER BY named DESC,latest DESC,entity_id LIMIT $3
          )
          SELECT c.entity_id AS "positionId",c.connection_id AS "connectionId",c.provider,
           c.sku_id AS "skuId",c.location_id AS "locationId",
           EXISTS(SELECT 1 FROM inventory_stock_ownership_scopes n WHERE n.tenant_id=$1 AND n.location_id=c.location_id::uuid AND n.mode='own') AS "nativeOwned",
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'resource',m.resource,'externalId',m.external_id,
             'scopeKey',m.scope_key,'createdAt',m.created_at) ORDER BY m.id)
            FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.connection_id=c.connection_id
             AND ((m.resource='sku' AND m.canonical_id=c.sku_id::uuid)
              OR (m.resource='location' AND m.canonical_id=c.location_id::uuid))),'[]'::jsonb) AS mappings
          FROM current c JOIN selected USING(entity_id)
          ORDER BY selected.named DESC,selected.latest DESC,c.entity_id,c.connection_id`,
          [context.tenantId, named, limit],
        );

        return z.array(positionRow).parse(result.rows);
      });
      const positions = new Map<
        string,
        Awaited<ReturnType<DetectionSources['stockPositions']>>[number]
      >();
      for (const row of rows) {
        // Only one exact mapping per side identifies the provider record to read.
        const source = exactSource(row);
        if (!source) continue;
        const position = positions.get(row.positionId) ?? {
          positionId: row.positionId,
          skuId: row.skuId,
          locationId: row.locationId,
          nativeOwned: row.nativeOwned,
          sources: [],
        };
        position.sources.push(source);
        positions.set(row.positionId, position);
      }

      return [...positions.values()].filter(
        (position) => position.sources.length > 1,
      );
    },
    async stockAgreement(
      context,
      { positionId, connectionIds: [left, right], since, until, tolerance },
    ) {
      // Each stored report is compared with the other side's latest report observed no later,
      // both inside the window: what Luma knew both sources said at that moment.
      const rows = await db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `WITH agreed AS (SELECT s.observed_at AS at,s.id AS "snapshotId",o.id AS "otherId",s.connection_id=$3 AS "isLeft"
          FROM inventory_snapshots s
          JOIN LATERAL (SELECT o.id,o.available FROM inventory_snapshots o
            WHERE o.tenant_id=$1 AND o.entity_id=$2 AND o.kind='position'
             AND o.connection_id=CASE WHEN s.connection_id=$3 THEN $4::uuid ELSE $3::uuid END
             AND o.observed_at>$5 AND o.observed_at<=s.observed_at
            ORDER BY o.observed_at DESC LIMIT 1) o ON true
          WHERE s.tenant_id=$1 AND s.entity_id=$2 AND s.kind='position' AND s.connection_id IN ($3,$4)
           AND s.observed_at>$5 AND s.observed_at<=$6 AND abs(s.available-o.available)<=$7::numeric
          ORDER BY s.observed_at DESC,s.id LIMIT 1)
          SELECT agreed.*,COALESCE((SELECT min(n.observed_at) FROM inventory_snapshots n
            WHERE n.tenant_id=$1 AND n.entity_id=$2 AND n.kind='position' AND n.connection_id IN ($3,$4)
             AND n.observed_at>agreed.at AND n.observed_at<=$6),$6) AS "mismatchSince"
          FROM agreed`,
          [context.tenantId, positionId, left, right, since, until, tolerance],
        );

        return z
          .array(
            z.object({
              at: time,
              mismatchSince: time,
              snapshotId: z.string().uuid(),
              otherId: z.string().uuid(),
              isLeft: z.boolean(),
            }),
          )
          .parse(result.rows);
      });
      const row = rows[0];
      if (!row) return null;

      return {
        agreedAt: row.at,
        mismatchSince: row.mismatchSince,
        snapshotIds: row.isLeft
          ? [row.snapshotId, row.otherId]
          : [row.otherId, row.snapshotId],
      };
    },
    async orderSources(context, orderId) {
      const rows = await db.transaction(context.tenantId, async (tx) => {
        // Internal sources such as Luma ERP have no app, so only the grant is checked here.
        const result = await tx.query(
          `SELECT p.connection_id AS "connectionId",c.document->>'provider' AS provider,
            m.external_id AS "externalId",m.scope_key AS "scopeKey",
            LEAST(s.observed_at,(SELECT min(fs.observed_at) FROM orders_snapshots fs
              JOIN orders_projections fp ON fp.tenant_id=fs.tenant_id AND fp.snapshot_id=fs.id
              WHERE fs.tenant_id=$1 AND fs.connection_id=p.connection_id AND fs.kind='fulfillment'
               AND fs.order_id=p.entity_id)) AS "observedAt",
            COALESCE(c.document->'permissions' ? 'fulfillment.read' AND c.document->'granted' ? 'fulfillment.read',false) AS fulfillments,
            COALESCE((SELECT jsonb_agg(o.document->'observation' ORDER BY fs.entity_id) FROM orders_snapshots fs
              JOIN orders_projections fp ON fp.tenant_id=fs.tenant_id AND fp.snapshot_id=fs.id
              JOIN connector_observations o ON o.tenant_id=fs.tenant_id AND o.connection_id=fs.connection_id AND o.id=fs.observation_id
              WHERE fs.tenant_id=$1 AND fs.connection_id=p.connection_id AND fs.kind='fulfillment'
               AND fs.order_id=p.entity_id AND fs.document->>'deleted' IS DISTINCT FROM 'true'),'[]'::jsonb) AS stored
          FROM orders_projections p
          JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='order'
          JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
          JOIN LATERAL (SELECT external_id,scope_key FROM connector_source_mappings
            WHERE tenant_id=$1 AND connection_id=p.connection_id AND resource='order' AND canonical_id=p.entity_id
            ORDER BY created_at,id LIMIT 1) m ON true
          WHERE p.tenant_id=$1 AND p.entity_id=$2 AND c.document->>'status'='active'
           AND c.document->'permissions' ? 'orders.read' AND c.document->'granted' ? 'orders.read'
           AND s.document->>'deleted' IS DISTINCT FROM 'true'
          ORDER BY p.connection_id`,
          [context.tenantId, orderId],
        );

        return z.array(orderSourceRow).parse(result.rows);
      });

      return rows.map((row) => ({
        connectionId: row.connectionId,
        provider: row.provider,
        order: { externalId: row.externalId, scopeKey: row.scopeKey },
        observedAt: row.observedAt,
        fulfillments: row.fulfillments,
        stored: row.stored,
      }));
    },
    async fulfillments(context, { before, include, limit }) {
      const named = include.map(
        (item) => `${item.fulfillmentId}/${item.connectionId}`,
      );
      const rows = await db.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          `SELECT l.entity_id AS "fulfillmentId",l.connection_id AS "connectionId",
            c.document->>'provider' AS provider,l.snapshot_id AS "snapshotId",l.observed_at AS "observedAt",
            o.document->'observation' AS observation
          FROM orders_fulfillment_list l
          JOIN connector_installations c ON c.tenant_id=l.tenant_id AND c.id=l.connection_id
          JOIN orders_snapshots s ON s.tenant_id=l.tenant_id AND s.id=l.snapshot_id
          JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.connection_id=s.connection_id
           AND o.id=s.observation_id
          WHERE l.tenant_id=$1 AND ${readable('fulfillment.read')}
           AND ((l.open AND l.progress_at<$2) OR l.entity_id::text||'/'||l.connection_id::text=ANY($3::text[]))
          ORDER BY (l.entity_id::text||'/'||l.connection_id::text=ANY($3::text[])) DESC,l.progress_at,l.entity_id
          LIMIT $4`,
          [context.tenantId, before, named, limit],
        );

        return z.array(fulfillmentRow).parse(result.rows);
      });

      return rows.map((row) => ({
        fulfillmentId: row.fulfillmentId,
        connectionId: row.connectionId,
        provider: row.provider,
        source: row.observation.source,
        order: row.observation.data.order,
        lines: row.observation.data.lines.map((line) => line.orderLine),
        snapshotId: row.snapshotId,
        observedAt: row.observedAt,
      }));
    },
  };
}
