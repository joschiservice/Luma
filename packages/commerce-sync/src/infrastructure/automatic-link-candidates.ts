import type { SqlTransaction } from '@luma/platform';

import type {
  AutoLinkPair,
  AutoLinkPreview,
} from '../domain/automatic-links.js';
import {
  autoLinkDisposition,
  autoLinkPolicy,
} from '../domain/automatic-links.js';

const skuRecords = `SELECT k.connection_id,k.code_key AS key,k.sku_id AS id,k.unit,
 COALESCE(i.status='current' AND i.missing_since IS NULL AND i.last_seen_at>=$4::timestamptz
  AND (k.source_updated_at IS NULL OR i.source_updated_at>=k.source_updated_at),false) AS fresh
 FROM inventory_product_skus k
 LEFT JOIN connector_source_mappings m ON m.tenant_id=k.tenant_id AND m.connection_id=k.connection_id
  AND m.resource='product' AND m.canonical_id=k.product_id
 LEFT JOIN commerce_sync_items i ON i.tenant_id=m.tenant_id AND i.connection_id=m.connection_id
  AND i.record_type='products' AND i.resource=m.resource AND i.scope_key=m.scope_key AND i.external_id=m.external_id
 WHERE k.tenant_id=$1 AND k.connection_id IN ($2,$3) AND k.code_key IS NOT NULL`;

const orderRecords = `SELECT o.connection_id,
 CASE WHEN o.connection_id=$2 THEN o.display_number_key ELSE o.external_order_key END AS key,
 o.entity_id AS id,'order' AS unit,
 COALESCE(i.status='current' AND i.missing_since IS NULL AND i.last_seen_at>=$4::timestamptz
  AND (o.source_updated_at IS NULL OR i.source_updated_at>=o.source_updated_at),false) AS fresh
 FROM orders_list o
 LEFT JOIN connector_source_mappings m ON m.tenant_id=o.tenant_id AND m.connection_id=o.connection_id
  AND m.resource='order' AND m.canonical_id=o.entity_id
 LEFT JOIN commerce_sync_items i ON i.tenant_id=m.tenant_id AND i.connection_id=m.connection_id
  AND i.record_type='orders' AND i.resource=m.resource AND i.scope_key=m.scope_key AND i.external_id=m.external_id
 WHERE o.tenant_id=$1 AND o.connection_id IN ($2,$3) AND NOT o.deleted`;

/** Reads only current owner projections and sync coverage; labels never become external IDs. */
export async function readAutoLinkPreview(
  tx: SqlTransaction,
  tenantId: string,
  pair: AutoLinkPair,
): Promise<AutoLinkPreview> {
  const counts: AutoLinkPreview['counts'] = {
    eligible: 0,
    ambiguous: 0,
    conflict: 0,
    excluded: 0,
    stale: 0,
  };
  const recordType = pair.kind === 'sku' ? 'products' : 'orders';
  const coverage = await tx.query<{ ready: boolean }>(
    `SELECT count(*)=2 AND COALESCE(bool_and(COALESCE(c.document->>'status'='active'
      AND c.document->'granted' ? $5 AND c.document->'permissions' ? $5
      AND NOT s.paused AND s.blocked IS NULL AND s.error_code IS NULL
      AND s.last_full_scan_at >= $4::timestamptz AND s.last_success_at >= $4::timestamptz
      AND NOT (COALESCE(s.scan IN ('backfill','reconcile'),false) OR s.suspended_scan IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM commerce_sync_items i WHERE i.tenant_id=s.tenant_id
        AND i.connection_id=s.connection_id AND i.record_type=s.record_type AND i.status<>'current'),false)),false) AS ready
     FROM connector_installations c LEFT JOIN commerce_sync_streams s ON s.tenant_id=c.tenant_id
      AND s.connection_id=c.id AND s.record_type=$6
     WHERE c.tenant_id=$1 AND c.id IN ($2,$3)`,
    [
      tenantId,
      pair.targetConnectionId,
      pair.sourceConnectionId,
      new Date(Date.now() - autoLinkPolicy.freshnessMs).toISOString(),
      `${recordType}.read`,
      recordType,
    ],
  );
  if (!coverage.rows[0]?.ready)
    return {
      ready: false,
      message:
        'Waiting for both connections to have complete, successful reads refreshed within the last day. Paused, failing or unavailable syncs cannot link records.',
      counts,
      candidates: [],
    };

  const result = await tx.query<{
    ambiguous: boolean;
    conflict: boolean;
    excluded: boolean;
    stale: boolean;
    count: number;
    candidates: { key: string; targetId: string; sourceId: string }[];
  }>(
    `WITH records AS (${pair.kind === 'sku' ? skuRecords : orderRecords}), grouped AS (
   SELECT connection_id,key,array_agg(DISTINCT id ORDER BY id) AS ids,
    array_agg(DISTINCT unit ORDER BY unit) AS units,bool_and(fresh) AS fresh
   FROM records WHERE key IS NOT NULL GROUP BY connection_id,key
  ), pairs AS (
   SELECT a.key,a.ids AS targets,b.ids AS sources,a.ids[1] AS target_id,b.ids[1] AS source_id,
    cardinality(a.ids)<>1 OR cardinality(b.ids)<>1 AS ambiguous,
    cardinality(a.units)<>1 OR cardinality(b.units)<>1 OR a.units<>b.units OR 'unknown'=ANY(a.units) AS unit_conflict,
    NOT (a.fresh AND b.fresh) AS stale
   FROM grouped a JOIN grouped b ON b.key=a.key AND b.connection_id=$3
   WHERE a.connection_id=$2 AND NOT (cardinality(a.ids)=1 AND a.ids=b.ids)
  ), facts AS (
   SELECT p.*,
    p.unit_conflict OR EXISTS (SELECT 1 FROM connector_source_mappings a
     JOIN connector_source_mappings b ON b.tenant_id=a.tenant_id AND b.connection_id=a.connection_id
      AND b.resource=a.resource AND b.canonical_id=ANY(p.sources)
     WHERE a.tenant_id=$1 AND a.resource=$5 AND a.canonical_id=ANY(p.targets))
    OR ($5='order' AND EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1
      AND m.resource='order' AND m.canonical_id=ANY(p.targets||p.sources) AND m.connection_id NOT IN ($2,$3)))
    OR (SELECT count(*) FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.resource=$5
      AND m.connection_id=$2 AND m.canonical_id=p.target_id)<>1
    OR (SELECT count(*) FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.resource=$5
      AND m.connection_id=$3 AND m.canonical_id=p.source_id)<>1 AS conflict,
    EXISTS (SELECT 1 FROM connector_source_mappings m JOIN connector_mapping_revisions r
     ON r.tenant_id=m.tenant_id AND r.mapping_id=m.id
     WHERE m.tenant_id=$1 AND m.resource=$5 AND m.canonical_id=ANY(p.targets||p.sources)
      AND r.method='Unlinked by a person from another source')
    OR EXISTS (SELECT 1 FROM commerce_identity_links l WHERE l.tenant_id=$1 AND l.kind=$5
      AND l.state IN ('requested','running') AND (l.entity_id=ANY(p.targets||p.sources)
       OR l.other_id=ANY(p.targets||p.sources))) AS excluded
   FROM pairs p
  ), numbered AS (
   SELECT *,row_number() OVER (PARTITION BY ambiguous,conflict,excluded,stale ORDER BY key) AS rank FROM facts
  ) SELECT ambiguous,conflict,excluded,stale,count(*)::int AS count,
    jsonb_agg(jsonb_build_object('key',key,'targetId',target_id,'sourceId',source_id) ORDER BY key)
     FILTER (WHERE rank<=20) AS candidates
   FROM numbered GROUP BY ambiguous,conflict,excluded,stale`,
    [
      tenantId,
      pair.targetConnectionId,
      pair.sourceConnectionId,
      new Date(Date.now() - autoLinkPolicy.freshnessMs).toISOString(),
      pair.kind,
    ],
  );
  const candidates: AutoLinkPreview['candidates'] = [];
  for (const row of result.rows) {
    const disposition = autoLinkDisposition(row);
    counts[disposition] += row.count;
    candidates.push(
      ...row.candidates.map((candidate) => ({ ...candidate, disposition })),
    );
  }
  candidates.sort(
    (a, b) =>
      Number(b.disposition === 'eligible') -
        Number(a.disposition === 'eligible') || a.key.localeCompare(b.key),
  );

  return {
    ready: true,
    message: null,
    counts,
    candidates: candidates.slice(0, autoLinkPolicy.batchSize),
  };
}
