import type { SqlTransaction } from '@luma/platform';

import type {
  CatalogItem,
  ProductDetail,
  ProductSales,
} from '../../application/products.js';
import { readPositions } from '../inventory/positions.js';
import { readable } from './catalog.js';

const salesDays = 30;

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Orders are read from the maintained SKU index; tenants still rebuilding it scan current orders.
const skuOrders = `WITH candidates AS (
  SELECT entity_id,connection_id FROM orders_list_skus
  WHERE tenant_id=$1 AND sku_id=$2 AND NOT EXISTS (SELECT 1 FROM orders_list_backfill b WHERE b.tenant_id=$1)
  UNION
  SELECT p.entity_id,p.connection_id FROM orders_projections p
  JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  WHERE p.tenant_id=$1 AND s.kind='order' AND EXISTS (SELECT 1 FROM orders_list_backfill b WHERE b.tenant_id=$1)
  AND s.document->'data'->'lines' @> jsonb_build_array(jsonb_build_object('skuId',$2::text))
), lines AS (
  SELECT s.entity_id,s.connection_id,s.document->'data'->>'status' AS status,
   COALESCE(s.document->'data'->>'displayNumber',s.entity_id::text) AS label,
   (s.document->'data'->>'placedAt')::timestamptz AS placed_at,line->>'unit' AS unit,
   (line->>'quantity')::numeric AS quantity,COALESCE((line->>'cancelledQuantity')::numeric,0) AS cancelled
  FROM candidates c
  JOIN orders_projections p ON p.tenant_id=$1 AND p.entity_id=c.entity_id AND p.connection_id=c.connection_id
  JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') line
  WHERE NOT (s.document->>'deleted')::boolean AND line->>'skuId'=$2::text
)`;

/**
 * Reads what depends on a SKU: other variants of its products, listing history, stock
 * positions, recent sales and related orders, purchase orders and issues. Sales and orders stay
 * per source because the same order can be mirrored in several systems.
 */
export async function readProductContext(
  tx: SqlTransaction,
  tenantId: string,
  item: CatalogItem,
): Promise<Omit<ProductDetail, 'item' | 'sources' | 'hidden' | 'asOf'>> {
  const bundles = await tx.query<NonNullable<ProductDetail['bundles']>[number]>(
    `SELECT k.connection_id AS "connectionId",k.product_id AS "productId",
    v.value->'bundle'->'variant' AS variant,(v.value->'bundle'->>'requiresComponents')::boolean AS "requiresComponents",
    v.value->'bundle'->'components' AS components,s.document->>'observedAt' AS "observedAt",s.document->>'sourceUpdatedAt' AS "sourceUpdatedAt"
    FROM inventory_product_skus k JOIN inventory_snapshots s ON s.tenant_id=k.tenant_id AND s.id=k.snapshot_id
    CROSS JOIN LATERAL (SELECT value FROM jsonb_array_elements(s.document->'data'->'skus') WHERE value->>'skuId'=$2::text LIMIT 1) v
    WHERE k.tenant_id=$1 AND k.sku_id=$2::uuid AND v.value ? 'bundle' ORDER BY k.connection_id,k.product_id`,
    [tenantId, item.skuId],
  );
  // Current labels aid navigation; the retained recipe is the only relationship evidence.
  const componentRefs = [
    ...new Map(
      bundles.rows.flatMap((recipe) =>
        (recipe.components ?? []).flatMap((component) =>
          component.skuId
            ? [
                [
                  `${recipe.connectionId}:${component.skuId}`,
                  { connectionId: recipe.connectionId, skuId: component.skuId },
                ] as const,
              ]
            : [],
        ),
      ),
    ).values(),
  ];
  if (componentRefs.length) {
    const labels = await tx.query<{
      connectionId: string;
      skuId: string;
      label: string | null;
    }>(
      `SELECT r.connection_id AS "connectionId",r.sku_id AS "skuId",k.code AS label
      FROM unnest($2::uuid[],$3::uuid[]) AS r(connection_id,sku_id)
      LEFT JOIN LATERAL (SELECT code FROM inventory_product_skus WHERE tenant_id=$1 AND connection_id=r.connection_id AND sku_id=r.sku_id ORDER BY observed_at DESC,product_id LIMIT 1) k ON true`,
      [
        tenantId,
        componentRefs.map((ref) => ref.connectionId),
        componentRefs.map((ref) => ref.skuId),
      ],
    );
    const byRef = new Map(
      labels.rows.map((row) => [`${row.connectionId}:${row.skuId}`, row.label]),
    );
    for (const recipe of bundles.rows)
      for (const component of recipe.components ?? [])
        component.skuLabel = component.skuId
          ? (byRef.get(`${recipe.connectionId}:${component.skuId}`) ?? null)
          : null;
  }
  const productIds = [...new Set(item.listings.map((l) => l.productId))];
  const variants = await tx.query<ProductDetail['variants'][number]>(
    `SELECT * FROM (SELECT DISTINCT ON (o.sku_id,o.connection_id) o.sku_id AS "skuId",
      COALESCE(o.code,${readable('e.reconciliation_key')}) AS sku,o.variant_title AS title,
      o.connection_id AS "connectionId",o.product_status AS status
     FROM inventory_product_skus o JOIN inventory_entities e ON e.tenant_id=o.tenant_id AND e.id=o.sku_id
     WHERE o.tenant_id=$1 AND o.product_id=ANY($2::uuid[]) AND o.sku_id<>$3
     ORDER BY o.sku_id,o.connection_id) v ORDER BY lower(sku),"skuId","connectionId" LIMIT 101`,
    [tenantId, productIds, item.skuId],
  );
  const history = await tx.query<ProductDetail['history']['entries'][number]>(
    `SELECT s.id,s.connection_id AS "connectionId",
      EXISTS (SELECT 1 FROM inventory_projections p WHERE p.tenant_id=s.tenant_id AND p.snapshot_id=s.id) AS current,
      (s.document->>'deleted')::boolean AS deleted,s.document->>'observedAt' AS "observedAt",
      s.document->>'sourceUpdatedAt' AS "sourceUpdatedAt",s.document->'data'->>'title' AS "productTitle",
      s.document->'data'->>'status' AS status,(s.document->'data'->>'published')::boolean AS published,
      CASE WHEN (s.document->>'deleted')::boolean THEN NULL ELSE v.value->'bundle' END AS bundle,
      CASE WHEN v.value->'price' IS NULL OR jsonb_typeof(v.value->'price')='null' THEN NULL ELSE v.value->'price' END AS price
     FROM inventory_snapshots s
     LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(s.document->'data'->'skus')
      WHERE value->>'skuId'=$3::text LIMIT 1) v ON true
     WHERE s.tenant_id=$1 AND s.kind='product' AND s.entity_id=ANY($2::uuid[])
     AND (v.value IS NOT NULL OR (s.document->>'deleted')::boolean)
     ORDER BY s.observed_at DESC,s.created_at DESC,s.id DESC LIMIT 51`,
    [tenantId, productIds, item.skuId],
  );
  const stock = await readPositions(
    tx,
    tenantId,
    { q: '', view: 'all', skuId: item.skuId },
    null,
  );
  const since = new Date(Date.now() - salesDays * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const sales = await tx.query<
    Omit<ProductSales, 'daily'> & {
      daily: ProductSales['daily'];
    }
  >(
    `${skuOrders}, recent AS (
      SELECT * FROM lines WHERE status<>'cancelled' AND placed_at>=$3
     ), days AS (
      SELECT connection_id,unit,to_char(placed_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
       sum(quantity-cancelled) AS quantity FROM recent GROUP BY 1,2,3
     )
     SELECT r.connection_id AS "connectionId",r.unit,count(DISTINCT r.entity_id)::int AS orders,
      sum(r.quantity-r.cancelled)::text AS quantity,${iso('max(r.placed_at)')} AS "lastPlacedAt",
      (SELECT jsonb_agg(jsonb_build_object('date',d.date,'quantity',d.quantity::text) ORDER BY d.date)
       FROM days d WHERE d.connection_id=r.connection_id AND d.unit=r.unit) AS daily
     FROM recent r GROUP BY r.connection_id,r.unit ORDER BY r.connection_id,r.unit`,
    [tenantId, item.skuId, since.toISOString()],
  );
  const orders = await tx.query<ProductDetail['orders'][number]>(
    `${skuOrders}
     SELECT entity_id AS id,label,status,connection_id AS "connectionId",sum(quantity)::text AS quantity,unit,
      ${iso('placed_at')} AS "placedAt"
     FROM lines GROUP BY entity_id,connection_id,label,status,unit,placed_at
     ORDER BY status='open' DESC,placed_at DESC NULLS LAST,entity_id,connection_id LIMIT 51`,
    [tenantId, item.skuId],
  );
  // Replenishment uses the canonical SKU reconciliation key on purchase order lines.
  const purchaseOrders = await tx.query<
    ProductDetail['purchaseOrders'][number]
  >(
    `SELECT p.id,p.document->>'reference' AS label,p.document->>'status' AS status,
     sum((line->>'quantity')::numeric)::float8 AS quantity,line->>'unit' AS unit
     FROM procurement_purchase_orders p CROSS JOIN LATERAL jsonb_array_elements(p.document->'lines') line
     WHERE p.tenant_id=$1 AND line->>'sku' IN ($2,$3)
     GROUP BY p.id,p.document,line->>'unit' ORDER BY p.document->>'status'='open' DESC,p.id LIMIT 51`,
    [tenantId, item.skuId, item.skuKey],
  );
  const issues = await tx.query<ProductDetail['issues'][number]>(
    `SELECT DISTINCT e.id,COALESCE(e.document->>'summary',e.document->>'exceptionClass','SKU issue') AS label,e.state
     FROM exceptions e WHERE e.tenant_id=$1 AND (
      (e.subject_kind='position' AND e.subject_id=ANY($4::text[])) OR
      (e.subject_kind='sku' AND (e.subject_id=$2 OR EXISTS (
       SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=e.tenant_id AND m.resource='sku'
       AND m.canonical_id=$2::uuid AND (m.external_id=e.subject_id OR e.subject_id=$3)
       AND e.document->'subject'->'scope' ? m.connection_id::text))))
     ORDER BY e.state,e.id LIMIT 51`,
    [tenantId, item.skuId, item.skuKey, stock.map((position) => position.id)],
  );

  return {
    bundles: bundles.rows,
    variants: variants.rows.slice(0, 100),
    history: {
      entries: history.rows.slice(0, 50),
      truncated: history.rows.length > 50,
    },
    stock: stock.slice(0, 50),
    sales: { since: since.toISOString(), sources: sales.rows },
    orders: orders.rows.slice(0, 50),
    purchaseOrders: purchaseOrders.rows.slice(0, 50),
    issues: issues.rows.slice(0, 50),
    relatedTruncated:
      variants.rows.length > 100 ||
      [stock, orders.rows, purchaseOrders.rows, issues.rows].some(
        (rows) => rows.length > 50,
      ),
  };
}
