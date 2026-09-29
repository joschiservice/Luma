// Probe at most 1,001 postings per gram to pick a selective seed without counting all
// matches. Correlated membership checks preserve streaming when every gram is common.
function candidates(name: string, table: string, id: string) {
  return `${name}_seed AS MATERIALIZED (
 SELECT q.gram FROM search_grams q ORDER BY
  (SELECT count(*) FROM (SELECT 1 FROM ${table} g WHERE g.tenant_id=$1 AND g.gram=q.gram LIMIT 1001) sample),q.gram
 LIMIT 1
), ${name}_candidates AS NOT MATERIALIZED (
 SELECT g.${id} FROM ${table} g WHERE g.tenant_id=$1 AND g.gram=(SELECT gram FROM ${name}_seed)
 AND NOT EXISTS (SELECT 1 FROM search_grams q WHERE NOT EXISTS (
   SELECT 1 FROM ${table} rest WHERE rest.tenant_id=$1 AND rest.gram=q.gram AND rest.${id}=g.${id} OFFSET 0
 ) OFFSET 0)
)`;
}

/**
 * Finds literal substring candidates through equality postings, then verifies each value.
 * Lateral lookups keep verification behind the postings lookup, without materializing
 * every candidate before the caller can stop. $14 is raw text; $15 is its escaped ILIKE pattern. Source scope also applies to aliases.
 */
const orderSearchValues = `search_grams AS MATERIALIZED (
 SELECT DISTINCT substr(lower($14),pos,LEAST(3,length(lower($14)))) COLLATE "C" AS gram
 FROM generate_series(1,GREATEST(1,length(lower($14))-2)) pos
), ${candidates('value', 'orders_search_grams', 'value_id')},
 ${candidates('mapping', 'connector_mapping_grams', 'mapping_id')},
 mapping_hits AS NOT MATERIALIZED (
 SELECT m.* FROM mapping_candidates c CROSS JOIN LATERAL (
 SELECT * FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.id=c.mapping_id
 AND ($3::uuid IS NULL OR m.connection_id=$3) AND m.external_id ILIKE $15 OFFSET 0) m
), value_hits AS NOT MATERIALIZED (
 SELECT v.id FROM value_candidates c CROSS JOIN LATERAL (
 SELECT id FROM orders_search_values v WHERE v.tenant_id=$1 AND v.id=c.value_id
 AND v.value ILIKE $15 OFFSET 0) v
)`;

/** Candidate order IDs, bounded by the caller before choosing a selective or broad plan. */
export const orderSearchHits = `${orderSearchValues}, hits AS MATERIALIZED (
 SELECT v.entity_id AS id FROM value_hits h CROSS JOIN LATERAL (
 SELECT entity_id FROM orders_search_links v WHERE v.tenant_id=$1 AND v.value_id=h.id
 AND ($3::uuid IS NULL OR v.connection_id=$3) OFFSET 0) v
 UNION ALL SELECT canonical_id FROM mapping_hits WHERE resource='order'
 UNION ALL SELECT s.entity_id FROM mapping_hits m CROSS JOIN LATERAL (
 SELECT entity_id FROM orders_list_skus s WHERE s.tenant_id=$1 AND s.sku_id=m.canonical_id
 AND ($3::uuid IS NULL OR s.connection_id=$3) OFFSET 0) s WHERE m.resource='sku'
 UNION ALL SELECT entity_id FROM orders_list WHERE tenant_id=$1
 AND entity_id=CASE WHEN $14 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $14::uuid END
 AND ($3::uuid IS NULL OR connection_id=$3)
 LIMIT 1001
)`;

/**
 * Checks only the values and aliases linked to one ordered row. OFFSET 0 preserves the
 * correlated lookup: PostgreSQL must not expand a common SKU into a tenant-wide hash set.
 */
export const orderSearchPredicate = `(EXISTS (
 SELECT 1 FROM orders_search_links v JOIN orders_search_values d ON d.tenant_id=$1 AND d.id=v.value_id
 WHERE v.tenant_id=$1 AND v.entity_id=o.entity_id
 AND ($3::uuid IS NULL OR v.connection_id=$3) AND d.value ILIKE $15 OFFSET 0)
 OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1 AND m.canonical_id=o.entity_id
 AND m.resource='order' AND ($3::uuid IS NULL OR m.connection_id=$3) AND m.external_id ILIKE $15 OFFSET 0)
 OR EXISTS (SELECT 1 FROM orders_list_skus s JOIN connector_source_mappings m ON m.tenant_id=$1 AND m.canonical_id=s.sku_id
 AND m.resource='sku' AND ($3::uuid IS NULL OR m.connection_id=$3) AND m.external_id ILIKE $15
 WHERE s.tenant_id=$1 AND s.entity_id=o.entity_id AND ($3::uuid IS NULL OR s.connection_id=$3) OFFSET 0)
 OR o.entity_id=CASE WHEN $14 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $14::uuid END)`;
