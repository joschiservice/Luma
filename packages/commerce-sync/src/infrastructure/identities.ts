import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type { IdentityReader } from '../application/service.js';
import type { IdentitySource } from '../application/views.js';
import { readableKey } from '../domain/labels.js';

type SourceRow = {
  canonical_id: string;
  connection_id: string;
  connection_label: string;
  provider: string;
  external_id: string;
  scope_key: string;
  method: string;
  created_at: Date;
  revised_at: Date | null;
  codes: string[];
  titles: string[];
};

async function sources(
  tx: SqlTransaction,
  tenantId: string,
  kind: 'sku' | 'location',
  ids: string[],
) {
  const rows = await tx.query<SourceRow>(
    `SELECT m.canonical_id,m.connection_id,COALESCE(c.document->>'label','Connected source') AS connection_label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind','source') AS provider,
      m.external_id,m.scope_key,COALESCE(r.method,m.method) AS method,m.created_at,r.created_at AS revised_at,
      ARRAY(SELECT DISTINCT k.code FROM inventory_product_skus k WHERE k.tenant_id=m.tenant_id
        AND k.sku_id=m.canonical_id AND k.connection_id=m.connection_id AND k.code_key IS NOT NULL ORDER BY k.code) AS codes,
      ARRAY(SELECT DISTINCT s.document->'data'->>'title' FROM inventory_product_skus k
        JOIN inventory_projections p ON p.tenant_id=k.tenant_id AND p.entity_id=k.product_id AND p.connection_id=k.connection_id
        JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
        WHERE k.tenant_id=m.tenant_id AND k.sku_id=m.canonical_id AND k.connection_id=m.connection_id
        AND NULLIF(btrim(s.document->'data'->>'title'),'') IS NOT NULL) AS titles
    FROM connector_source_mappings m
    LEFT JOIN connector_installations c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id
    LEFT JOIN LATERAL (SELECT method,created_at FROM connector_mapping_revisions r
      WHERE r.tenant_id=m.tenant_id AND r.mapping_id=m.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
    WHERE m.tenant_id=$1 AND m.resource=$2 AND m.canonical_id=ANY($3::uuid[])
    ORDER BY connection_label,m.connection_id,m.external_id`,
    [tenantId, kind, ids],
  );
  const grouped = new Map<string, IdentitySource[]>();
  for (const row of rows.rows)
    grouped.set(row.canonical_id, [
      ...(grouped.get(row.canonical_id) ?? []),
      {
        connectionId: row.connection_id,
        connectionLabel: row.connection_label,
        provider: row.provider,
        externalId: row.external_id,
        scopeKey: row.scope_key,
        method: row.method,
        linkedAt: row.created_at.toISOString(),
        revisedAt: row.revised_at?.toISOString() ?? null,
        codes: row.codes,
        titles: row.titles,
      },
    ]);

  return grouped;
}

function label(kind: 'sku' | 'location', key: string, items: IdentitySource[]) {
  const code = items.flatMap((item) => item.codes)[0];
  if (code) return code;
  const title = items.flatMap((item) => item.titles)[0];
  if (title) return title;

  return readableKey(kind, key, items[0]?.connectionLabel);
}

/**
 * Reads the sources behind one SKU or location. SKU suggestions come from other connections'
 * SKUs with the same normalized code; a code is a hint for a person, never identity.
 */
export function createIdentityReader(db: TenantDatabase): IdentityReader {
  return (tenantId, kind, entityId) =>
    db.transaction(
      tenantId,
      async (tx) => {
        const entity = (
          await tx.query<{ reconciliation_key: string }>(
            'SELECT reconciliation_key FROM inventory_entities WHERE tenant_id=$1 AND kind=$2 AND id=$3',
            [tenantId, kind, entityId],
          )
        ).rows[0];
        if (!entity) return null;
        const own =
          (await sources(tx, tenantId, kind, [entityId])).get(entityId) ?? [];
        const candidates =
          kind === 'sku'
            ? (
                await tx.query<{
                  id: string;
                  reconciliation_key: string;
                  code: string;
                }>(
                  `SELECT DISTINCT ON (other.sku_id) other.sku_id AS id,e.reconciliation_key,other.code
                  FROM inventory_product_skus mine
                  JOIN inventory_product_skus other ON other.tenant_id=mine.tenant_id
                    AND other.code_key=mine.code_key AND other.sku_id<>mine.sku_id
                  JOIN inventory_entities e ON e.tenant_id=other.tenant_id AND e.id=other.sku_id
                  WHERE mine.tenant_id=$1 AND mine.sku_id=$2 AND mine.code_key IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM connector_source_mappings a
                      JOIN connector_source_mappings b ON b.tenant_id=a.tenant_id AND b.connection_id=a.connection_id
                        AND b.resource='sku' AND b.canonical_id=other.sku_id
                      WHERE a.tenant_id=$1 AND a.resource='sku' AND a.canonical_id=$2)
                  ORDER BY other.sku_id,other.code LIMIT 10`,
                  [tenantId, entityId],
                )
              ).rows
            : [];
        const others = await sources(
          tx,
          tenantId,
          kind,
          candidates.map((candidate) => candidate.id),
        );

        return {
          entity: {
            id: entityId,
            kind,
            label: label(kind, entity.reconciliation_key, own),
          },
          sources: own,
          suggestions: candidates.map((candidate) => {
            const items = others.get(candidate.id) ?? [];

            return {
              id: candidate.id,
              label: label(kind, candidate.reconciliation_key, items),
              reason: `Same SKU code “${candidate.code}”`,
              sources: items,
            };
          }),
        };
      },
      { readOnlySnapshot: true },
    );
}
