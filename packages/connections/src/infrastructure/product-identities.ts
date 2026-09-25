import type { TenantDatabase } from '@luma/platform';

/** Reads the latest observed product labels for explicitly mapped SKU identities in one tenant. */
export function createProductIdentityReader(db: TenantDatabase) {
  return (tenantId: string, skuId: string) =>
    db.transaction(tenantId, async (tx) => {
      const result = await tx.query<{
        source: string;
        title: string | null;
        sku: string | null;
      }>(
        `WITH products AS (
          SELECT DISTINCT ON (r.connection_id, p->'source'->>'scopeKey', p->'source'->>'externalId')
            r.connection_id, p
          FROM connector_read_checks r
          CROSS JOIN LATERAL jsonb_array_elements(r.document->'value'->'items') p
          WHERE r.tenant_id=$1 AND r.capability='products.read' AND r.succeeded
            AND p->'source'->>'tenantId'=$1::text
            AND p->'source'->>'connectionId'=r.connection_id::text
            AND p->'source'->>'resource'='product'
            AND EXISTS (SELECT 1 FROM connector_source_mappings m
              WHERE m.tenant_id=$1 AND m.connection_id=r.connection_id
                AND m.resource='sku' AND m.canonical_id=$2)
          ORDER BY r.connection_id, p->'source'->>'scopeKey', p->'source'->>'externalId',
            (p->>'observedAt')::timestamptz DESC, r.id DESC
        )
        SELECT DISTINCT p->'source'->>'provider' AS source,
          NULLIF(btrim(p->'data'->>'title'),'') AS title,
          NULLIF(btrim(s->>'code'),'') AS sku
        FROM products
        CROSS JOIN LATERAL jsonb_array_elements(p->'data'->'skus') s
        JOIN connector_source_mappings m ON m.tenant_id=$1
          AND m.connection_id=products.connection_id AND m.resource='sku' AND m.canonical_id=$2
          AND m.external_id=s->'id'->>'externalId' AND m.scope_key=s->'id'->>'scopeKey'
        WHERE p->>'kind'='snapshot'
          AND (NULLIF(btrim(p->'data'->>'title'),'') IS NOT NULL OR NULLIF(btrim(s->>'code'),'') IS NOT NULL)
        ORDER BY source, title, sku`,
        [tenantId, skuId],
      );

      return result.rows;
    });
}
