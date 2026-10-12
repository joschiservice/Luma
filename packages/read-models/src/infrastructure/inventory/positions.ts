import type { SqlTransaction } from '@luma/platform';

import type {
  InventoryQuery,
  StockPosition,
  StockSource,
} from '../../application/inventory.js';
import { stockDifferences } from '../../domain/inventory.js';

type PositionRow = {
  id: string;
  skuId: string;
  sku: string;
  skuKey: string;
  locationId: string;
  location: string;
  unit: string;
  source: StockSource;
};

// Imported records use source-local keys; show the trailing part of the source ID instead.
const readable = (key: string, noun: string) =>
  `CASE WHEN left(${key},10)='["source",' THEN '${noun} '||regexp_replace((${key})::jsonb->>4,'^.*/','') ELSE ${key} END`;

const positionRows = `FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 JOIN inventory_entities e ON e.tenant_id=p.tenant_id AND e.id=(s.document->'data'->>'skuId')::uuid
 JOIN inventory_entities l ON l.tenant_id=p.tenant_id AND l.id=(s.document->'data'->>'locationId')::uuid`;
const positionScope = `WHERE p.tenant_id=$1 AND s.kind='position' AND NOT (s.document->>'deleted')::boolean AND ($2::uuid IS NULL OR p.entity_id=$2)
 AND ($3::uuid IS NULL OR s.document->'data'->>'skuId'=$3::text)
 AND ($4::uuid IS NULL OR s.document->'data'->>'locationId'=$4::text)
 AND ($5::uuid IS NULL OR p.entity_id>$5)`;

const sourceRows = `SELECT p.entity_id AS id,
 s.document->'data'->>'skuId' AS "skuId", s.document->'data'->>'locationId' AS "locationId",
 s.document->'data'->>'unit' AS unit, e.reconciliation_key AS "skuKey",
 COALESCE((SELECT k.code FROM inventory_product_skus k WHERE k.tenant_id=p.tenant_id AND k.sku_id=e.id
  AND k.code_key IS NOT NULL ORDER BY k.connection_id LIMIT 1),${readable('e.reconciliation_key', 'SKU')}) AS sku,
 ${readable('l.reconciliation_key', 'Location')} AS location,
 jsonb_build_object('connectionId',p.connection_id,'label',COALESCE(c.document->>'label','Connected source'),
 'status',COALESCE(c.document->>'status','unknown'),
 'externalSku',sku.external_id,'externalLocation',location.external_id,'mappingMethod',sku.method,
 'onHand',s.document->'data'->'onHand','reserved',s.document->'data'->'reserved',
 'available',s.document->'data'->'available','incoming',NULL,
 'availabilityBasis',s.document->'data'->>'availabilityBasis','observedAt',s.document->>'observedAt',
 'sourceUpdatedAt',s.document->>'sourceUpdatedAt','deleted',s.document->'deleted') AS source
 ${positionRows}
 LEFT JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
 LEFT JOIN LATERAL (SELECT external_id,method FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
 AND m.connection_id=p.connection_id AND m.resource='sku' AND m.canonical_id=(s.document->'data'->>'skuId')::uuid ORDER BY external_id LIMIT 1) sku ON true
 LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
 AND m.connection_id=p.connection_id AND m.resource='location' AND m.canonical_id=(s.document->'data'->>'locationId')::uuid ORDER BY external_id LIMIT 1) location ON true
 ${positionScope}`;

/** Reads a bounded page, retaining all sources even when a search or source filter matches only one. */
export async function readPositions(
  tx: SqlTransaction,
  tenantId: string,
  query: InventoryQuery,
  after: string | null,
  id: string | null = null,
) {
  const selectPageFirst = query.q === '' && query.view === 'all';
  const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const result = await tx.query<PositionRow>(
    // Search and difference views need source facts before paging. The all view only
    // needs position IDs; enrich its page afterwards without hiding other sources.
    selectPageFirst
      ? `WITH selected AS MATERIALIZED (
    SELECT p.entity_id AS id ${positionRows} ${positionScope}
    GROUP BY p.entity_id
    HAVING ($6::uuid IS NULL OR bool_or(p.connection_id=$6))
    ORDER BY id LIMIT 51
  ), sources AS (${sourceRows} AND p.entity_id IN (SELECT id FROM selected))
  SELECT sources.* FROM sources ORDER BY id,source->>'label',source->>'connectionId'`
      : `WITH sources AS (${sourceRows}), selected AS (
    SELECT id FROM sources
    GROUP BY id
    HAVING ($6::text='' OR bool_or(source->>'externalSku' ILIKE $7 OR source->>'externalLocation' ILIKE $7
      OR location ILIKE $7 OR sku ILIKE $7 OR "skuId" ILIKE $7 OR "locationId" ILIKE $7 OR id::text ILIKE $7))
    AND ($8::uuid IS NULL OR bool_or(source->>'connectionId'=$8::text))
    AND ($9='all' OR ($9='unknown' AND bool_or((source->>'deleted')::boolean OR source->>'onHand' IS NULL OR source->>'reserved' IS NULL OR source->>'available' IS NULL))
      OR ($9='differs' AND (
       count(DISTINCT (source->>'onHand')::numeric) FILTER (WHERE NOT (source->>'deleted')::boolean)>1
       OR count(DISTINCT (source->>'reserved')::numeric) FILTER (WHERE NOT (source->>'deleted')::boolean)>1
       OR count(DISTINCT (source->>'available')::numeric) FILTER (WHERE NOT (source->>'deleted')::boolean)>1)))
    ORDER BY id LIMIT 51
  ) SELECT sources.* FROM sources JOIN selected USING(id) ORDER BY id,source->>'label',source->>'connectionId'`,
    [
      tenantId,
      id,
      query.skuId ?? null,
      query.locationId ?? null,
      after,
      ...(selectPageFirst
        ? [query.connectionId ?? null]
        : [query.q, pattern, query.connectionId ?? null, query.view]),
    ],
  );
  const grouped = new Map<string, PositionRow[]>();
  for (const row of result.rows) {
    const rows = grouped.get(row.id) ?? [];
    rows.push(row);
    grouped.set(row.id, rows);
  }
  const waits = await readSyncWaits(
    tx,
    tenantId,
    [...grouped.values()].map((rows) => rows[0]!.skuId),
  );

  return [...grouped.values()].map((rows) =>
    position(rows, waits.get(`${rows[0]!.skuId}/${rows[0]!.locationId}`)),
  );
}

/**
 * Stock gaps the detector is currently letting provider sync close, by `skuId/locationId`.
 * A wait that was not reconfirmed within five minutes or whose deadline passed is omitted:
 * the gap has closed or is about to be raised.
 */
export async function readSyncWaits(
  tx: SqlTransaction,
  tenantId: string,
  skuIds: string[],
) {
  const result = await tx.query<{
    key: string;
    since: Date;
    until: Date;
  }>(
    `SELECT subject_id||'/'||(scope->>0) AS key,min(mismatch_since) AS since,max(wait_until) AS until
     FROM exception_pending_sync WHERE tenant_id=$1 AND subject_kind='sku' AND subject_id=ANY($2::text[])
      AND wait_until>now() AND evaluated_at>now()-interval '5 minutes'
     GROUP BY 1`,
    [tenantId, [...new Set(skuIds)]],
  );

  return new Map(
    result.rows.map((row) => [
      row.key,
      { since: row.since.toISOString(), until: row.until.toISOString() },
    ]),
  );
}

function position(
  rows: PositionRow[],
  sync: StockPosition['sync'] = null,
): StockPosition {
  const first = rows[0]!;
  const sources = rows.map((row) => row.source);

  return {
    id: first.id,
    skuId: first.skuId,
    sku: first.sku,
    skuKey: first.skuKey,
    locationId: first.locationId,
    location: first.location,
    unit: first.unit,
    sources,
    differences: stockDifferences(sources),
    // A wait describes an open gap; once the stored reports agree it no longer applies.
    sync: stockDifferences(sources).includes('available') ? sync : null,
  };
}
