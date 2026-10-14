import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  CatalogField,
  CatalogItem,
  CatalogListing,
  CatalogSource,
  CatalogView,
  ProductQuery,
  ProductSort,
} from '../../application/products.js';
import {
  collectionCustomFields,
  customFieldIds,
  customSort,
} from '../collection/custom-fields.js';
import { groupMemberPredicate } from '../collection/group.js';
import {
  collectionContext,
  collectionGrouping,
  collectionGroupLimit,
} from '../collection/request.js';
import { compileWhere } from '../collection/where.js';
import {
  rankedGroupCtes,
  rankedGroupHeadIds,
  type RankedGroupRow,
  rankedGroupsJson,
} from '../list-groups.js';
import {
  listKeyset,
  type ListOrder,
  type ListPosition,
  positionOf,
} from '../list-paging.js';
import {
  productCollectionFields,
  productGroupFields,
  productSourceConditions,
} from './collection-fields.js';

type SkuRow = {
  skuId: string;
  sku: string;
  skuKey: string;
  title: string | null;
  listRank: boolean;
  listKeys: string[] | null;
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
const sortOrders: Record<ProductSort, Omit<ListOrder, 'ids' | 'direction'>> = {
  rank: {
    keys: [
      { sql: 'rank', type: 'integer' },
      { sql: 'sort_key COLLATE "C"', type: 'text' },
    ],
    missing: false,
  },
  sku: { keys: [{ sql: 'lower(code)', type: 'text' }] },
  title: { keys: [{ sql: 'lower(title)', type: 'text' }] },
  price: {
    keys: [
      { sql: 'price_currency', type: 'text' },
      { sql: 'price_amount', type: 'numeric' },
    ],
  },
  updated: { keys: [{ sql: 'updated_at', type: 'timestamptz' }] },
  differences: {
    keys: [{ sql: 'difference_count', type: 'integer' }],
    missing: false,
  },
  listings: {
    keys: [{ sql: 'listing_count', type: 'integer' }],
    missing: false,
  },
};

function isNativeSort(sort: string): sort is ProductSort {
  return Object.hasOwn(sortOrders, sort);
}

/** How the catalog query selects the SKUs it returns, with trusted, parameterized SQL. */
interface CatalogSqlOptions {
  order: ReturnType<typeof listKeyset>;
  /** Aggregate columns over the catalog rows `c` of one SKU, with a leading comma. */
  aggregates: string;
  /** Conditions over the compared SKU row `o`. */
  where: string;
  /** Narrows the page to one group. */
  member: string | null;
  /** Grouped reads: `rankedGroupCtes` over `matched`; the page holds every group's head SKUs. */
  groups: { ctes: string; headIds: string } | null;
}

/**
 * The catalog list query. Parameters: $1 tenant, $2 search text, $3 its escaped ILIKE pattern,
 * $4 listed-in connection, $5 missing-from connection, $6 view, $7 SKU ID, $8 page size plus
 * one; later parameters belong to the keyset, conditions and grouping.
 */
const catalogSql = ({
  order,
  aggregates,
  where,
  member,
  groups,
}: CatalogSqlOptions) => `WITH catalog AS MATERIALIZED (
  SELECT sku_id,connection_id,product_id,code,code_key,product_title,variant_title,product_status,
   published,vendor,barcode,price_amount,price_currency,title_key,barcode_key,source_updated_at,requires_components
  FROM inventory_product_skus WHERE tenant_id=$1 AND ($7::uuid IS NULL OR sku_id=$7 OR code_key IN (
   SELECT code_key FROM inventory_product_skus WHERE tenant_id=$1 AND sku_id=$7))
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
   COALESCE(min(barcode_key)<>max(barcode_key),false) AS barcode_differs,
   count(*)::int AS listing_count,max(source_updated_at) AS updated_at,
   array_agg(DISTINCT NULLIF(btrim(vendor),'')) FILTER (WHERE NULLIF(btrim(vendor),'') IS NOT NULL) AS vendors,
   array_agg(DISTINCT product_status) AS statuses${aggregates}
  FROM catalog c
  WHERE ($2='' OR sku_id IN (SELECT sku_id FROM searched)) AND ($7::uuid IS NULL OR sku_id=$7)
  GROUP BY sku_id
), prices AS (
  SELECT DISTINCT sku_id FROM catalog WHERE price_currency IS NOT NULL
  GROUP BY sku_id,price_currency HAVING min(price_amount)<>max(price_amount)
), lowest_prices AS (
  SELECT DISTINCT ON (sku_id) sku_id,price_currency,price_amount FROM catalog
  WHERE price_currency IS NOT NULL AND price_amount IS NOT NULL
  ORDER BY sku_id,price_currency,price_amount
), matches AS (
  SELECT DISTINCT ON (a.sku_id,b.connection_id) a.sku_id,b.connection_id,b.sku_id AS match_id,b.code AS match
  FROM catalog a JOIN catalog b ON b.code_key=a.code_key AND b.sku_id<>a.sku_id AND b.connection_id<>a.connection_id
  WHERE a.code_key IS NOT NULL AND ($2='' OR a.sku_id IN (SELECT sku_id FROM searched))
  ORDER BY a.sku_id,b.connection_id,b.sku_id
), unlinked AS (
  SELECT DISTINCT m.sku_id FROM matches m JOIN skus s ON s.sku_id=m.sku_id WHERE NOT m.connection_id=ANY(s.connections)
), compared AS (
  SELECT s.*,pr.sku_id IS NOT NULL AS price_differs,u.sku_id IS NOT NULL AS unlinked,
   (title_differs OR status_differs OR published_differs OR pr.sku_id IS NOT NULL OR barcode_differs) AS differs,
   (title_differs::int+status_differs::int+published_differs::int+(pr.sku_id IS NOT NULL)::int+barcode_differs::int) AS difference_count,
   array_remove(ARRAY[CASE WHEN title_differs THEN 'title' END,CASE WHEN status_differs THEN 'status' END,
    CASE WHEN published_differs THEN 'published' END,CASE WHEN pr.sku_id IS NOT NULL THEN 'price' END,
    CASE WHEN barcode_differs THEN 'barcode' END],NULL) AS differences,
   ARRAY(SELECT g.connection_id FROM sources g WHERE NOT g.connection_id=ANY(s.connections)) AS gap_ids,
   NOT (SELECT array_agg(connection_id) FROM sources)<@s.connections AS missing,
   CASE WHEN s.code IS NOT NULL THEN 0 WHEN s.title IS NOT NULL THEN 1 ELSE 2 END AS rank,
   (lower(COALESCE(s.code,s.title,'')) COLLATE "C") AS sort_key,lp.price_currency,lp.price_amount
  FROM skus s LEFT JOIN unlinked u ON u.sku_id=s.sku_id LEFT JOIN prices pr ON pr.sku_id=s.sku_id
  LEFT JOIN lowest_prices lp ON lp.sku_id=s.sku_id
  WHERE ($4::uuid IS NULL OR $4=ANY(s.connections)) AND ($5::uuid IS NULL OR NOT $5=ANY(s.connections))
), filtered AS (
  SELECT o.* FROM compared o WHERE ${where}
), matched AS (
  SELECT o.* FROM filtered o
  WHERE ($6='all' OR ($6='differs' AND differs) OR ($6='missing' AND missing) OR ($6='unlinked' AND unlinked))
   ${member ? `AND ${member}` : ''}
), ${
  groups
    ? `${groups.ctes}, selected AS (
  SELECT *,false AS list_rank,NULL::text[] AS list_keys,row_number() OVER (ORDER BY ${order.orderBy}) AS n FROM matched o
  WHERE sku_id IN (${groups.headIds}) AND $8::int IS NOT NULL
)`
    : `selected AS (
  SELECT *,${order.position},row_number() OVER (ORDER BY ${order.orderBy}) AS n FROM matched o
  WHERE ${order.predicate}
  ORDER BY ${order.orderBy} LIMIT $8
)`
}, page AS (
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
 ${member ? '(SELECT count(*) FROM matched)::int' : 'NULL::int'} AS "matchedCount",
 ${groups ? rankedGroupsJson : 'NULL::jsonb'} AS groups,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('skuId',p.sku_id,'sku',COALESCE(p.code,${readable('p.sku_key')}),
  'skuKey',p.sku_key,'title',p.title,'listRank',p.list_rank,'listKeys',p.list_keys,'gaps',COALESCE(g.gaps,'[]'),
  'differences',to_jsonb(p.differences))
  ORDER BY p.n) FROM page p LEFT JOIN gaps g ON g.sku_id=p.sku_id),'[]') AS page`;

/**
 * Options of a list read: the reader and read time that conditions resolve against. Custom
 * field conditions and sorts need the reader, whose permissions decide which fields it may use.
 */
interface CatalogReadOptions {
  tenant?: TenantContext;
  asOf: string;
}

/**
 * Reads one catalog page of up to `limit` + 1 SKUs with per-view counts. Search matches any
 * source's listing text or source IDs but the result retains every source for comparison.
 * Conditions narrow the counts too. With `group` and no `groupKey`, returns every group's
 * exact count and first SKUs instead of a page; with `groupKey`, a page of that group and its
 * exact count. Conditions and the sort may name readable custom product fields, which filter
 * before paging. Throws a 400 error for invalid conditions and groupings or unavailable custom
 * fields, and a 403 error for custom fields the reader may not read.
 */
export async function readCatalog(
  tx: SqlTransaction,
  tenantId: string,
  query: ProductQuery,
  after: ListPosition | null,
  skuId: string | null = null,
  options: CatalogReadOptions = { asOf: new Date().toISOString() },
) {
  const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const values: unknown[] = [
    tenantId,
    query.q,
    pattern,
    query.connectionId ?? null,
    query.missingFrom ?? null,
    query.view,
    skuId,
    (query.limit ?? 50) + 1,
  ];
  const { request, grouped } = collectionGrouping(query, productGroupFields);
  const sort = query.sort ?? 'rank';
  const context = collectionContext(
    values,
    options.asOf,
    query.timeZone,
    options.tenant?.actor.id ?? '',
  );
  const customIds = customFieldIds([
    ...(query.where?.conditions.map((condition) => condition.field) ?? []),
    sort,
  ]);
  if (customIds.length && !options.tenant)
    throw new Error('Custom product fields need the reader');
  const custom =
    customIds.length && options.tenant
      ? await collectionCustomFields(
          tx,
          options.tenant,
          { type: 'product', id: 'o.sku_id' },
          customIds,
          context.parameters,
          context.timeZone,
        )
      : undefined;
  const order = listKeyset(
    {
      // A custom field's value is NULL when unset, so those SKUs come last.
      ...(isNativeSort(sort)
        ? sortOrders[sort]
        : {
            keys: customSort(custom?.sorts, sort).keys.map((key) => ({
              sql: key.sql,
              type: key.cast,
            })),
          }),
      ids: ['sku_id'],
      direction: query.direction ?? 'asc',
    },
    after,
    values,
  );
  const scoped = productSourceConditions();
  const where = query.where?.conditions.length
    ? compileWhere(
        query.where,
        { ...productCollectionFields(scoped), ...custom?.fields },
        context,
      ).sql
    : 'true';
  const member =
    request && query.groupKey !== undefined
      ? groupMemberPredicate(request, query.groupKey, context)
      : null;
  const groups =
    request && grouped
      ? {
          ctes: rankedGroupCtes(
            'matched',
            'o.sku_id',
            request,
            order,
            context.parameters.bind(collectionGroupLimit(query), 'integer'),
            context,
          ),
          headIds: rankedGroupHeadIds,
        }
      : null;
  const result = await tx.query<{
    counts: Record<CatalogView, number>;
    matchedCount: number | null;
    groups: RankedGroupRow[] | null;
    page: SkuRow[];
  }>(
    catalogSql({
      order,
      aggregates: scoped.select(),
      where,
      member,
      groups,
    }),
    values,
  );
  const { counts, matchedCount, page } = result.rows[0]!;
  const listings = await readListings(
    tx,
    tenantId,
    page.map((row) => row.skuId),
  );

  return {
    counts,
    matchedCount,
    groups: result.rows[0]!.groups,
    items: page.map((row) => ({
      position: positionOf(
        { list_rank: row.listRank, list_keys: row.listKeys },
        [row.skuId],
      ),
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
     k.published,k.vendor,k.barcode,k.requires_components AS "requiresComponents",
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
