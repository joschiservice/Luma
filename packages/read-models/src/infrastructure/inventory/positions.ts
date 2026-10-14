import type { SqlTransaction } from '@luma/platform';

import type {
  InventoryQuery,
  InventorySort,
  StockPosition,
  StockSource,
} from '../../application/inventory.js';
import { stockDifferences } from '../../domain/inventory.js';
import { groupMemberPredicate } from '../collection/group.js';
import { likePattern } from '../collection/parameters.js';
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
  inventoryCollectionFields,
  inventoryGroupFields,
  inventorySourceConditions,
} from './collection-fields.js';

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
 AND ($4::uuid IS NULL OR s.document->'data'->>'locationId'=$4::text)`;

const sourceRows = `SELECT p.entity_id AS id,
 s.document->'data'->>'skuId' AS "skuId", s.document->'data'->>'locationId' AS "locationId",
 s.document->'data'->>'unit' AS unit, e.reconciliation_key AS "skuKey",
 COALESCE((SELECT k.code FROM inventory_product_skus k WHERE k.tenant_id=p.tenant_id AND k.sku_id=e.id
  AND k.code_key IS NOT NULL ORDER BY k.connection_id LIMIT 1),${readable('e.reconciliation_key', 'SKU')}) AS sku,
 ${readable('l.reconciliation_key', 'Location')} AS location,
 jsonb_build_object('connectionId',p.connection_id,'label',COALESCE(c.document->>'label','Connected source'),
 'status',COALESCE(c.document->>'status','unknown'),
 'externalSku',sku.external_id,'externalLocation',location.external_id,'mappingMethod',sku.method,
 'onHand',s.document->'data'->'onHand',
 'reserved',CASE WHEN c.document->>'provider'='shopify' AND s.document->>'schemaVersion'='1' THEN NULL ELSE s.document->'data'->'reserved' END,
 'committed',CASE WHEN c.document->>'provider'='shopify' AND s.document->>'schemaVersion'='1' THEN s.document->'data'->'reserved' ELSE s.document->'data'->'committed' END,
 'available',s.document->'data'->'available','incoming',s.document->'data'->'incoming',
 'damaged',s.document->'data'->'damaged',
 'qualityControl',s.document->'data'->'qualityControl',
 'safetyStock',s.document->'data'->'safetyStock',
 'locationActive',s.document->'data'->'locationActive',
 'itemActive',s.document->'data'->'itemActive',
 'tracked',s.document->'data'->'tracked',
 'bundleContext',(SELECT jsonb_build_object('observedAt',to_char(k.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'componentCount',k.component_count)
 FROM inventory_product_skus k WHERE k.tenant_id=p.tenant_id AND k.connection_id=p.connection_id AND k.sku_id=e.id
 AND (k.requires_components OR k.component_count>0) ORDER BY k.observed_at DESC,k.product_id LIMIT 1),
 'writeAttribution',s.document->'data'->'writeAttribution',
 'inventorySemantics',CASE WHEN c.document->>'provider'='shopify' THEN to_jsonb('shopify/1'::text) ELSE s.document->'data'->'inventorySemantics' END,
 'availabilityBasis',s.document->'data'->>'availabilityBasis','observedAt',s.document->>'observedAt',
 'sourceUpdatedAt',s.document->>'sourceUpdatedAt','deleted',s.document->'deleted') AS source
 ${positionRows}
 LEFT JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
 LEFT JOIN LATERAL (SELECT external_id,method FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
 AND m.connection_id=p.connection_id AND m.resource='sku' AND m.canonical_id=(s.document->'data'->>'skuId')::uuid ORDER BY external_id LIMIT 1) sku ON true
 LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id
 AND m.connection_id=p.connection_id AND m.resource='location' AND m.canonical_id=(s.document->'data'->>'locationId')::uuid ORDER BY external_id LIMIT 1) location ON true
 ${positionScope}`;

const labels = [
  { sql: 'sku', type: 'text' },
  { sql: 'location', type: 'text' },
] as const;

/** A quantity or time sort; positions without a value follow, still by SKU and location. */
const reported = (
  column: string,
  type: 'numeric' | 'timestamptz',
): Omit<ListOrder, 'ids' | 'direction'> => ({
  keys: [
    {
      sql: `COALESCE(${column},${type === 'numeric' ? '0' : "'-infinity'"}::${type})`,
      type,
    },
    ...labels,
  ],
  missing: `${column} IS NULL`,
});

// SKU and location labels are always set.
const sortOrders: Record<
  InventorySort,
  Omit<ListOrder, 'ids' | 'direction'>
> = {
  sku: { keys: labels, missing: false },
  location: { keys: [labels[1], labels[0]], missing: false },
  available: reported('available', 'numeric'),
  onHand: reported('on_hand', 'numeric'),
  incoming: reported('incoming', 'numeric'),
  lastRead: reported('last_read', 'timestamptz'),
};

/** How the position query selects the positions it returns, with trusted, parameterized SQL. */
interface PositionSqlOptions {
  order: ReturnType<typeof listKeyset>;
  limit: string;
  search: boolean;
  /** Aggregate columns over the source rows `c` of one position, with a leading comma. */
  aggregates: string;
  /** Conditions over the position row `o`, including a group's member predicate. */
  where: string;
  count: boolean;
  /** Grouped reads: `rankedGroupCtes` over `filtered`; the page holds every group's head positions. */
  groups: { ctes: string; headIds: string } | null;
}

/**
 * The position list query. Parameters: $1 tenant, $2 position ID, $3 SKU, $4 location, $5
 * connection, $6 view, $7 search text and $8 its escaped ILIKE pattern; later parameters
 * belong to the keyset, conditions and grouping. Every current source contributes typed facts
 * once; labels, mappings and display facts are read only for the returned page.
 */
const positionSql = ({
  order,
  limit,
  search,
  aggregates,
  where,
  count,
  groups,
}: PositionSqlOptions) => `WITH position_sources AS MATERIALIZED (
 SELECT p.entity_id AS id,p.connection_id,e.id AS sku_id,l.id AS location_id,
  e.reconciliation_key AS sku_key,l.reconciliation_key AS location_key,s.on_hand,s.available,
  CASE WHEN c.document->>'provider'='shopify' AND s.document->>'schemaVersion'='1' THEN NULL ELSE s.reserved END AS reserved,
  (s.document->'data'->>'incoming')::numeric AS incoming,(s.document->'data'->>'safetyStock')::numeric AS safety_stock,
  (s.document->'data'->>'tracked')::boolean AS tracked,(s.document->'data'->>'itemActive')::boolean AS item_active,
  (s.document->'data'->>'locationActive')::boolean AS location_active,
  s.document->'data'->>'availabilityBasis' AS availability_basis,(s.document->>'observedAt')::timestamptz AS observed_at,
  CASE WHEN c.document->>'provider'='shopify' THEN 'shopify/1' ELSE s.document->'data'->>'inventorySemantics' END AS semantics
  ${
    search
      ? `,EXISTS(SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=p.tenant_id AND m.connection_id=p.connection_id
   AND ((m.resource='sku' AND m.canonical_id=e.id) OR (m.resource='location' AND m.canonical_id=l.id)) AND m.external_id ILIKE $8) AS mapped`
      : ''
  }
 ${positionRows}
 LEFT JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
 ${positionScope}
), positions AS (
 SELECT id,(array_agg(sku_id))[1] AS sku_id,(array_agg(location_id))[1] AS location_id,
  (array_agg(sku_key))[1] AS sku_key,(array_agg(location_key))[1] AS location_key,
  array_agg(connection_id ORDER BY connection_id) AS connections,
  min(available) AS available,min(on_hand) AS on_hand,min(incoming) AS incoming,max(observed_at) AS last_read,
  count(DISTINCT on_hand)>1 AS on_hand_differs,
  (count(DISTINCT reserved) FILTER (WHERE semantics IS NULL)>1 OR count(DISTINCT reserved) FILTER (WHERE semantics='shopify/1')>1) AS reserved_differs,
  count(DISTINCT available)>1 AS available_differs,
  bool_or(on_hand IS NULL OR reserved IS NULL OR available IS NULL) AS has_unknown
  ${search ? ',bool_or(mapped) AS mapped' : ''}${aggregates}
 FROM position_sources c GROUP BY id
), codes AS (
 SELECT DISTINCT ON (sku_id) sku_id,code FROM inventory_product_skus
 WHERE tenant_id=$1 AND code_key IS NOT NULL ORDER BY sku_id,connection_id
), labeled AS (
 SELECT g.*,COALESCE(k.code,${readable('g.sku_key', 'SKU')}) AS sku,${readable('g.location_key', 'Location')} AS location,
  array_remove(ARRAY[CASE WHEN g.on_hand_differs THEN 'onHand' END,CASE WHEN g.reserved_differs THEN 'reserved' END,
   CASE WHEN g.available_differs THEN 'available' END],NULL) AS differences
 FROM positions g LEFT JOIN codes k ON k.sku_id=g.sku_id
), filtered AS (
 SELECT o.* FROM labeled o
 WHERE ($5::uuid IS NULL OR $5=ANY(o.connections))
 AND ($6='all' OR ($6='unknown' AND o.has_unknown) OR ($6='differs' AND cardinality(o.differences)>0))
 AND ${
   search
     ? `$7::text<>'' AND (o.mapped OR o.location ILIKE $8 OR o.sku ILIKE $8 OR o.sku_id::text ILIKE $8
  OR o.location_id::text ILIKE $8 OR o.id::text ILIKE $8)`
     : "$7::text='' AND $8::text IS NOT NULL"
 }
 AND ${where}
), ${
  groups
    ? `${groups.ctes}, page AS MATERIALIZED (
 SELECT id,false AS list_rank,NULL::text[] AS list_keys,row_number() OVER (ORDER BY ${order.orderBy}) AS n
 FROM filtered WHERE id IN (${groups.headIds}) AND ${limit}::int IS NOT NULL
)`
    : `page AS MATERIALIZED (
 SELECT id,${order.position},row_number() OVER (ORDER BY ${order.orderBy}) AS n
 FROM filtered WHERE ${order.predicate} ORDER BY ${order.orderBy} LIMIT ${limit}
)`
}
SELECT ${count ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS total,
 ${groups ? rankedGroupsJson : 'NULL::jsonb'} AS groups,
 COALESCE((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('listRank',page.list_rank,'listKeys',page.list_keys)
  ORDER BY page.n,r.source->>'label',r.source->>'connectionId')
  FROM (${sourceRows} AND p.entity_id IN (SELECT id FROM page)) r JOIN page USING(id)),'[]'::jsonb) AS rows`;

/** Options of a list read: the reader and read time that conditions resolve against. */
interface PositionReadOptions {
  userId: string;
  asOf: string;
}

/**
 * Reads a page of up to `limit` + 1 positions in the requested order, retaining all sources
 * even when a search, source filter or condition matches only one. Counts matches when asked
 * and always within one group. With `group` and no `groupKey`, returns every group's exact
 * count and first positions instead of a page. Throws a 400 error for invalid conditions.
 */
export async function readPositionPage(
  tx: SqlTransaction,
  tenantId: string,
  query: InventoryQuery,
  after: ListPosition | null,
  id: string | null = null,
  options: PositionReadOptions = {
    userId: '',
    asOf: new Date().toISOString(),
  },
) {
  const search = query.q !== '';
  const values: unknown[] = [
    tenantId,
    id,
    query.skuId ?? null,
    query.locationId ?? null,
    query.connectionId ?? null,
    query.view,
    query.q,
    likePattern(query.q),
  ];
  const { request, grouped } = collectionGrouping(query, inventoryGroupFields);
  const order = listKeyset(
    {
      ...sortOrders[query.sort ?? 'sku'],
      ids: ['id'],
      direction: query.direction ?? 'asc',
    },
    after,
    values,
  );
  values.push((query.limit ?? 50) + 1);
  const limit = `$${values.length}`;
  const context = collectionContext(
    values,
    options.asOf,
    query.timeZone,
    options.userId,
  );
  const scoped = inventorySourceConditions();
  const predicates = [
    ...(query.where?.conditions.length
      ? [
          compileWhere(query.where, inventoryCollectionFields(scoped), context)
            .sql,
        ]
      : []),
    ...(request && query.groupKey !== undefined
      ? [groupMemberPredicate(request, query.groupKey, context)]
      : []),
  ];
  const groups =
    request && grouped
      ? {
          ctes: rankedGroupCtes(
            'filtered',
            'o.id',
            request,
            order,
            context.parameters.bind(collectionGroupLimit(query), 'integer'),
            context,
          ),
          headIds: rankedGroupHeadIds,
        }
      : null;
  const result = await tx.query<{
    total: number | null;
    groups: RankedGroupRow[] | null;
    rows: (PositionRow & { listRank: boolean; listKeys: string[] | null })[];
  }>(
    positionSql({
      order,
      limit,
      search,
      aggregates: scoped.select(),
      where: predicates.length ? predicates.join(' AND ') : 'true',
      count: query.count === 'exact' || query.groupKey !== undefined,
      groups,
    }),
    values,
  );
  const { total, rows } = result.rows[0]!;
  const byPosition = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPosition.get(row.id) ?? [];
    list.push(row);
    byPosition.set(row.id, list);
  }
  const waits = await readSyncWaits(
    tx,
    tenantId,
    [...byPosition.values()].map((list) => list[0]!.skuId),
  );

  return {
    totalCount: total,
    groups: result.rows[0]!.groups,
    rows: [...byPosition.values()].map((list) => ({
      item: position(
        list,
        waits.get(`${list[0]!.skuId}/${list[0]!.locationId}`),
      ),
      position: positionOf(
        { list_rank: list[0]!.listRank, list_keys: list[0]!.listKeys },
        [list[0]!.id],
      ),
    })),
  };
}

/** Reads up to `limit` + 1 positions, retaining all sources even when a search or source filter matches only one. */
export async function readPositions(
  tx: SqlTransaction,
  tenantId: string,
  query: InventoryQuery,
  after: ListPosition | null,
  id: string | null = null,
) {
  return (await readPositionPage(tx, tenantId, query, after, id)).rows.map(
    (row) => row.item,
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
