import type { SqlTransaction } from '@luma/platform';

import type {
  CatalogField,
  CatalogItem,
  CatalogListing,
  CatalogSource,
  CatalogView,
  ProductQuery,
} from '../../application/products.js';

/** Position of the last SKU on a page, in catalog order. */
export interface CatalogPosition {
  rank: number;
  key: string;
  skuId: string;
}

type SkuRow = {
  skuId: string;
  sku: string;
  skuKey: string;
  title: string | null;
  rank: number;
  key: string;
  differences: CatalogField[];
  gaps: {
    connectionId: string;
    matchId: string | null;
    match: string | null;
  }[];
};

/** SQL that labels a SKU key; imported records show the trailing part of their source ID. */
export const readable = (key: string) =>
  `CASE WHEN left(${key},10)='["source",' THEN 'SKU '||regexp_replace((${key})::jsonb->>4,'^.*/','') ELSE ${key} END`;

/*
 * The comparison rules, written once for list and detail:
 * - title: product and variant title, ignoring case, spacing and punctuation;
 * - status: known statuses (unknown is not compared);
 * - published: reported listing state;
 * - price: amounts within the same reported currency; prices without a currency are not compared;
 * - barcode: ignoring surrounding space and leading zeros (UPC-A and EAN-13 forms agree).
 * A gap is a catalog source that currently lists none of the SKU. A match in a gap is another
 * SKU in that source with the same normalized SKU code, which a person may link.
 */
const catalogSql = `WITH catalog AS MATERIALIZED (
  SELECT sku_id,connection_id,product_id,code,code_key,product_title,variant_title,product_status,
   published,vendor,barcode,price_amount,price_currency,title_key,barcode_key
  FROM inventory_product_skus WHERE tenant_id=$1 AND ($10::uuid IS NULL OR sku_id=$10 OR code_key IN (
   SELECT code_key FROM inventory_product_skus WHERE tenant_id=$1 AND sku_id=$10))
), sources AS (
  SELECT DISTINCT connection_id FROM inventory_product_skus WHERE tenant_id=$1
), searched AS (
  SELECT DISTINCT sku_id FROM catalog c WHERE $2<>'' AND (c.code ILIKE $3 OR c.product_title ILIKE $3
   OR c.variant_title ILIKE $3 OR c.barcode ILIKE $3 OR c.vendor ILIKE $3 OR c.sku_id::text=lower($2)
   OR c.product_id IN (SELECT canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
    AND m.resource='product' AND m.external_id ILIKE $3)
   OR c.sku_id IN (SELECT canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
    AND m.resource='sku' AND m.external_id ILIKE $3))
), skus AS (
  SELECT sku_id,array_agg(connection_id) AS connections,
   min(code) FILTER (WHERE code_key IS NOT NULL) AS code,
   min(concat_ws(' · ',product_title,variant_title)) FILTER (WHERE product_title IS NOT NULL) AS title,
   COALESCE(min(title_key)<>max(title_key),false) AS title_differs,
   COALESCE(min(product_status) FILTER (WHERE product_status<>'unknown')
    <>max(product_status) FILTER (WHERE product_status<>'unknown'),false) AS status_differs,
   COALESCE(bool_or(published)<>bool_and(published),false) AS published_differs,
   COALESCE(min(barcode_key)<>max(barcode_key),false) AS barcode_differs
  FROM catalog c
  WHERE ($2='' OR sku_id IN (SELECT sku_id FROM searched)) AND ($10::uuid IS NULL OR sku_id=$10)
  GROUP BY sku_id
), prices AS (
  SELECT DISTINCT sku_id FROM catalog WHERE price_currency IS NOT NULL
  GROUP BY sku_id,price_currency HAVING min(price_amount)<>max(price_amount)
), matches AS (
  SELECT DISTINCT ON (a.sku_id,b.connection_id) a.sku_id,b.connection_id,b.sku_id AS match_id,b.code AS match
  FROM catalog a JOIN catalog b ON b.code_key=a.code_key AND b.sku_id<>a.sku_id AND b.connection_id<>a.connection_id
  WHERE a.code_key IS NOT NULL AND ($2='' OR a.sku_id IN (SELECT sku_id FROM searched))
  ORDER BY a.sku_id,b.connection_id,b.sku_id
), unlinked AS (
  SELECT DISTINCT m.sku_id FROM matches m JOIN skus s ON s.sku_id=m.sku_id WHERE NOT m.connection_id=ANY(s.connections)
), filtered AS (
  SELECT s.*,pr.sku_id IS NOT NULL AS price_differs,u.sku_id IS NOT NULL AS unlinked,
   (title_differs OR status_differs OR published_differs OR pr.sku_id IS NOT NULL OR barcode_differs) AS differs,
   NOT (SELECT array_agg(connection_id) FROM sources)<@s.connections AS missing,
   CASE WHEN s.code IS NOT NULL THEN 0 WHEN s.title IS NOT NULL THEN 1 ELSE 2 END AS rank,
   (lower(COALESCE(s.code,s.title,'')) COLLATE "C") AS key
  FROM skus s LEFT JOIN unlinked u ON u.sku_id=s.sku_id LEFT JOIN prices pr ON pr.sku_id=s.sku_id
  WHERE ($4::uuid IS NULL OR $4=ANY(s.connections)) AND ($5::uuid IS NULL OR NOT $5=ANY(s.connections))
), selected AS (
  SELECT * FROM filtered
  WHERE ($6='all' OR ($6='differs' AND differs) OR ($6='missing' AND missing) OR ($6='unlinked' AND unlinked))
   AND ($7::int IS NULL OR (rank,key,sku_id)>($7,$8 COLLATE "C",$9::uuid))
  ORDER BY rank,key,sku_id LIMIT $11
), page AS (
  SELECT s.*,e.reconciliation_key AS sku_key FROM selected s
  JOIN inventory_entities e ON e.tenant_id=$1 AND e.id=s.sku_id
), gaps AS (
  SELECT p.sku_id,jsonb_agg(jsonb_build_object('connectionId',g.connection_id,'matchId',m.match_id,'match',m.match)
   ORDER BY g.connection_id) AS gaps
  FROM page p CROSS JOIN sources g
  LEFT JOIN matches m ON m.sku_id=p.sku_id AND m.connection_id=g.connection_id
  WHERE NOT g.connection_id=ANY(p.connections) GROUP BY p.sku_id
)
SELECT (SELECT jsonb_build_object('all',count(*),'differs',count(*) FILTER (WHERE differs),
  'missing',count(*) FILTER (WHERE missing),'unlinked',count(*) FILTER (WHERE unlinked)) FROM filtered) AS counts,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('skuId',p.sku_id,'sku',COALESCE(p.code,${readable('p.sku_key')}),
  'skuKey',p.sku_key,'title',p.title,'rank',p.rank,'key',p.key,'gaps',COALESCE(g.gaps,'[]'),
  'differences',to_jsonb(array_remove(ARRAY[CASE WHEN p.title_differs THEN 'title' END,
   CASE WHEN p.status_differs THEN 'status' END,CASE WHEN p.published_differs THEN 'published' END,
   CASE WHEN p.price_differs THEN 'price' END,CASE WHEN p.barcode_differs THEN 'barcode' END],NULL)))
  ORDER BY p.rank,p.key,p.sku_id) FROM page p LEFT JOIN gaps g ON g.sku_id=p.sku_id),'[]') AS page`;

/**
 * Reads one catalog page of up to `limit` + 1 SKUs with per-view counts. Search matches any source's
 * listing text or source IDs but the result retains every source for comparison.
 */
export async function readCatalog(
  tx: SqlTransaction,
  tenantId: string,
  query: ProductQuery,
  after: CatalogPosition | null,
  skuId: string | null = null,
) {
  const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const result = await tx.query<{
    counts: Record<CatalogView, number>;
    page: SkuRow[];
  }>(catalogSql, [
    tenantId,
    query.q,
    pattern,
    query.connectionId ?? null,
    query.missingFrom ?? null,
    query.view,
    after?.rank ?? null,
    after?.key ?? null,
    after?.skuId ?? null,
    skuId,
    (query.limit ?? 50) + 1,
  ]);
  const { counts, page } = result.rows[0]!;
  const listings = await readListings(
    tx,
    tenantId,
    page.map((row) => row.skuId),
  );

  return {
    counts,
    items: page.map((row) => ({
      position: { rank: row.rank, key: row.key, skuId: row.skuId },
      item: {
        skuId: row.skuId,
        sku: row.sku,
        skuKey: row.skuKey,
        title: row.title,
        listings: listings.get(row.skuId) ?? [],
        differences: row.differences,
        gaps: row.gaps.map((gap) => ({
          connectionId: gap.connectionId,
          match:
            gap.matchId && gap.match
              ? { skuId: gap.matchId, sku: gap.match }
              : null,
        })),
      } satisfies CatalogItem,
    })),
  };
}

/** Reads a SKU that exists as a canonical identity but may have no current catalog listing. */
export async function readSku(
  tx: SqlTransaction,
  tenantId: string,
  skuId: string,
) {
  const result = await tx.query<{ skuKey: string; sku: string }>(
    `SELECT reconciliation_key AS "skuKey",${readable('reconciliation_key')} AS sku
     FROM inventory_entities WHERE tenant_id=$1 AND kind='sku' AND id=$2`,
    [tenantId, skuId],
  );

  return result.rows[0] ?? null;
}

async function readListings(
  tx: SqlTransaction,
  tenantId: string,
  skuIds: string[],
) {
  const grouped = new Map<string, CatalogListing[]>();
  if (!skuIds.length) return grouped;
  const result = await tx.query<CatalogListing & { skuId: string }>(
    `SELECT k.sku_id AS "skuId",k.connection_id AS "connectionId",k.product_id AS "productId",
     (SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=k.tenant_id AND m.resource='product'
      AND m.canonical_id=k.product_id AND m.connection_id=k.connection_id ORDER BY m.external_id LIMIT 1) AS "externalProduct",
     (SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=k.tenant_id AND m.resource='sku'
      AND m.canonical_id=k.sku_id AND m.connection_id=k.connection_id ORDER BY m.external_id LIMIT 1) AS "externalSku",
     k.code,k.product_title AS "productTitle",k.variant_title AS "variantTitle",k.product_status AS status,
     k.published,k.vendor,k.barcode,
     CASE WHEN k.price_amount IS NULL THEN NULL ELSE jsonb_build_object('amount',k.price_amount::text,'currency',k.price_currency) END AS price,
     k.unit,to_char(k.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
     to_char(k.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceUpdatedAt"
     FROM inventory_product_skus k WHERE k.tenant_id=$1 AND k.sku_id=ANY($2::uuid[])
     ORDER BY k.sku_id,k.connection_id,k.product_id`,
    [tenantId, skuIds],
  );
  for (const { skuId, ...listing } of result.rows) {
    const rows = grouped.get(skuId) ?? [];
    rows.push(listing);
    grouped.set(skuId, rows);
  }

  return grouped;
}

/** Lists connections that shared products, with catalog size and the latest full catalog read. */
export async function readSources(tx: SqlTransaction, tenantId: string) {
  const result = await tx.query<CatalogSource>(
    `WITH counted AS (SELECT connection_id,count(DISTINCT sku_id)::int AS skus FROM inventory_product_skus
      WHERE tenant_id=$1 GROUP BY connection_id)
     SELECT c.id AS "connectionId",COALESCE(c.document->>'label',c.document->'target'->>'kind','Connected source') AS label,
      c.document->'target'->>'kind' AS system,COALESCE(c.document->>'status','unknown') AS status,
      COALESCE(n.skus,0) AS "skuCount",
      to_char(st.last_full_scan_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "fullReadAt",
      to_char(st.last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastReadAt",
      st.error_code IS NOT NULL AS failing
     FROM connector_installations c
     LEFT JOIN counted n ON n.connection_id=c.id
     LEFT JOIN commerce_sync_streams st ON st.tenant_id=c.tenant_id AND st.connection_id=c.id AND st.record_type='products'
     WHERE c.tenant_id=$1 AND n.connection_id IS NOT NULL
     ORDER BY label,c.id`,
    [tenantId],
  );

  return result.rows;
}
