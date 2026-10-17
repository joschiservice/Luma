import type { TenantDatabase } from '@luma/platform';

/**
 * Reads the latest observed product labels for explicitly mapped SKU identities in one tenant.
 * Labels come from the latest stored revision of each product page item, so the read is bounded
 * by the SKU's mappings rather than by the number of retained product pages.
 */
export function createProductIdentityReader(db: TenantDatabase) {
  return (tenantId: string, skuId: string) =>
    db.transaction(tenantId, async (tx) => {
      const result = await tx.query<{
        source: string;
        title: string | null;
        sku: string | null;
      }>(
        `SELECT DISTINCT l.item->'source'->>'provider' AS source,
          NULLIF(btrim(l.item->'data'->>'title'),'') AS title,
          NULLIF(btrim(s->>'code'),'') AS sku
        FROM connector_source_mappings m
        JOIN connector_product_label_skus k ON k.tenant_id=$1 AND k.connection_id=m.connection_id
          AND k.sku_scope_key=m.scope_key AND k.sku_external_id=m.external_id
        JOIN connector_product_labels l ON l.tenant_id=$1 AND l.connection_id=k.connection_id
          AND l.scope_key=k.scope_key AND l.external_id=k.external_id
        CROSS JOIN LATERAL jsonb_array_elements(l.item->'data'->'skus') s
        WHERE m.tenant_id=$1 AND m.resource='sku' AND m.canonical_id=$2
          AND s->'id'->>'externalId'=m.external_id AND s->'id'->>'scopeKey'=m.scope_key
          AND l.item->>'kind'='snapshot'
          AND (NULLIF(btrim(l.item->'data'->>'title'),'') IS NOT NULL OR NULLIF(btrim(s->>'code'),'') IS NOT NULL)
        ORDER BY source, title, sku`,
        [tenantId, skuId],
      );

      return result.rows;
    });
}
