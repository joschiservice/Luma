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
  order_facts: IdentitySource['order'] | null;
  codes: string[];
  titles: string[];
};

async function sources(
  tx: SqlTransaction,
  tenantId: string,
  kind: 'sku' | 'location' | 'order' | 'order_line',
  ids: string[],
) {
  if (kind === 'order_line') {
    const grouped = new Map<string, IdentitySource[]>();
    for (const line of await readLineFacts(tx, tenantId, ids))
      grouped.set(line.canonicalId, [
        ...(grouped.get(line.canonicalId) ?? []),
        line.source,
      ]);

    return grouped;
  }
  const rows = await tx.query<SourceRow>(
    `SELECT m.canonical_id,m.connection_id,COALESCE(c.document->>'label','Connected source') AS connection_label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind','source') AS provider,
      (SELECT jsonb_build_object('number',l.display_number,'externalNumber',l.external_order_number,
        'placedAt',snap.document->'data'->'placedAt','total',snap.document->'data'->'total')
        FROM orders_list l JOIN orders_snapshots snap ON snap.tenant_id=l.tenant_id AND snap.id=l.snapshot_id
        WHERE l.tenant_id=m.tenant_id AND l.entity_id=m.canonical_id AND l.connection_id=m.connection_id) AS order_facts,
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
        ...(row.order_facts ? { order: row.order_facts } : {}),
        codes: row.codes,
        titles: row.titles,
      },
    ]);

  return grouped;
}

function label(
  kind: 'sku' | 'location' | 'order' | 'order_line',
  key: string,
  items: IdentitySource[],
) {
  if (kind === 'order')
    return items.find((item) => item.order?.number)?.order?.number ?? 'Order';
  const code = items.flatMap((item) => item.codes)[0];
  if (code) return code;
  const title = items.flatMap((item) => item.titles)[0];
  if (title) return title;

  return kind === 'order_line'
    ? (items[0]?.externalId ?? 'Order line')
    : readableKey(kind, key, items[0]?.connectionLabel);
}

/**
 * Reads sources and match signals for manual review across connections.
 * Automatic linking evaluates these signals separately under configured rules.
 */
export function createIdentityReader(db: TenantDatabase): IdentityReader {
  return (tenantId, kind, entityId) =>
    db.transaction(
      tenantId,
      async (tx) => {
        if (kind === 'order') return readOrderIdentity(tx, tenantId, entityId);
        if (kind === 'order_line')
          return readLineIdentity(tx, tenantId, entityId);
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

/** Suggests an external source reference matching a Shopify order number for manual confirmation. */
async function readOrderIdentity(
  tx: SqlTransaction,
  tenantId: string,
  entityId: string,
) {
  const own =
    (await sources(tx, tenantId, 'order', [entityId])).get(entityId) ?? [];
  if (!own.length) return null;
  const candidates = (
    await tx.query<{ id: string; number: string }>(
      `SELECT DISTINCT ON (other.entity_id) other.entity_id AS id,
      COALESCE(mine.external_order_number,other.external_order_number) AS number
     FROM orders_list mine JOIN connector_installations a ON a.tenant_id=mine.tenant_id AND a.id=mine.connection_id
     JOIN orders_list other ON other.tenant_id=mine.tenant_id AND other.entity_id<>mine.entity_id
       AND ((mine.external_order_key IS NOT NULL AND mine.external_order_key=other.display_number_key)
         OR (other.external_order_key IS NOT NULL AND other.external_order_key=mine.display_number_key))
     JOIN connector_installations b ON b.tenant_id=other.tenant_id AND b.id=other.connection_id
     WHERE mine.tenant_id=$1 AND mine.entity_id=$2 AND NOT mine.deleted AND NOT other.deleted
       AND ((COALESCE(a.document->>'provider',a.document->'target'->>'kind')<>'shopify' AND COALESCE(b.document->>'provider',b.document->'target'->>'kind')='shopify' AND mine.external_order_key=other.display_number_key)
         OR (COALESCE(a.document->>'provider',a.document->'target'->>'kind')='shopify' AND COALESCE(b.document->>'provider',b.document->'target'->>'kind')<>'shopify' AND other.external_order_key=mine.display_number_key))
       AND NOT EXISTS (SELECT 1 FROM connector_source_mappings x JOIN connector_source_mappings y
         ON y.tenant_id=x.tenant_id AND y.connection_id=x.connection_id AND y.resource='order' AND y.canonical_id=other.entity_id
         WHERE x.tenant_id=$1 AND x.resource='order' AND x.canonical_id=$2)
     ORDER BY other.entity_id,number LIMIT 10`,
      [tenantId, entityId],
    )
  ).rows;
  const others = await sources(
    tx,
    tenantId,
    'order',
    candidates.map((candidate) => candidate.id),
  );

  return {
    entity: {
      id: entityId,
      kind: 'order' as const,
      label: label('order', '', own),
    },
    sources: own,
    suggestions: candidates.map((candidate) => ({
      id: candidate.id,
      label: label('order', '', others.get(candidate.id) ?? []),
      reason: `Source external order number “${candidate.number}” matches Shopify`,
      sources: others.get(candidate.id) ?? [],
    })),
  };
}

/** Current, source-specific line facts; historical parent bindings alone never make a line selectable. */
async function readLineFacts(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
) {
  const { rows } = await tx.query<{
    canonical_id: string;
    order_id: string;
    unit: string;
    connection_id: string;
    connection_label: string;
    provider: string;
    external_id: string;
    scope_key: string;
    method: string;
    created_at: Date;
    revised_at: Date | null;
    title: string | null;
    sku_code: string | null;
  }>(
    `SELECT m.canonical_id,r.order_id,line->>'unit' AS unit,m.connection_id,
      COALESCE(c.document->>'label','Connected source') AS connection_label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind','source') AS provider,
      m.external_id,m.scope_key,COALESCE(revision.method,m.method) AS method,m.created_at,
      revision.created_at AS revised_at,line->>'title' AS title,line->>'skuCode' AS sku_code
     FROM connector_source_mappings m
     JOIN orders_relationships r ON r.tenant_id=m.tenant_id AND r.child_id=m.canonical_id
     JOIN orders_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.order_id AND p.connection_id=m.connection_id
     JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='order'
     CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') line
     JOIN connector_installations c ON c.tenant_id=m.tenant_id AND c.id=m.connection_id
     LEFT JOIN LATERAL (SELECT method,created_at FROM connector_mapping_revisions revision
       WHERE revision.tenant_id=m.tenant_id AND revision.mapping_id=m.id
       ORDER BY revision.created_at DESC,revision.id DESC LIMIT 1) revision ON true
     WHERE m.tenant_id=$1 AND m.resource='order_line' AND m.canonical_id=ANY($2::uuid[])
       AND line->>'id'=m.canonical_id::text AND NOT COALESCE((s.document->>'deleted')::boolean,false)
     ORDER BY m.canonical_id,m.connection_id,m.external_id`,
    [tenantId, ids],
  );

  return rows.map((row) => ({
    canonicalId: row.canonical_id,
    orderId: row.order_id,
    unit: row.unit,
    source: {
      connectionId: row.connection_id,
      connectionLabel: row.connection_label,
      provider: row.provider,
      externalId: row.external_id,
      scopeKey: row.scope_key,
      method: row.method,
      linkedAt: row.created_at.toISOString(),
      revisedAt: row.revised_at?.toISOString() ?? null,
      codes: row.sku_code ? [row.sku_code] : [],
      titles: row.title ? [row.title] : [],
    } satisfies IdentitySource,
  }));
}

/** Offers bounded, explicit choices from other sources of the already-linked order; text never matches identity. */
async function readLineIdentity(
  tx: SqlTransaction,
  tenantId: string,
  entityId: string,
) {
  const facts = await readLineFacts(tx, tenantId, [entityId]);
  const first = facts[0];
  if (
    !first ||
    facts.some(
      (line) => line.orderId !== first.orderId || line.unit !== first.unit,
    )
  )
    return null;
  const candidates = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT m.canonical_id AS id FROM connector_source_mappings m
     JOIN orders_relationships r ON r.tenant_id=m.tenant_id AND r.child_id=m.canonical_id
     JOIN orders_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.order_id AND p.connection_id=m.connection_id
     JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='order'
     CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') line
     WHERE m.tenant_id=$1 AND m.resource='order_line' AND r.order_id=$2 AND m.canonical_id<>$3
       AND line->>'id'=m.canonical_id::text AND line->>'unit'=$4
       AND NOT COALESCE((s.document->>'deleted')::boolean,false)
       AND NOT EXISTS (SELECT 1 FROM connector_source_mappings own JOIN connector_source_mappings other
         ON other.tenant_id=own.tenant_id AND other.connection_id=own.connection_id AND other.resource='order_line' AND other.canonical_id=m.canonical_id
         WHERE own.tenant_id=m.tenant_id AND own.resource='order_line' AND own.canonical_id=$3)
     ORDER BY m.canonical_id LIMIT 100`,
      [tenantId, first.orderId, entityId, first.unit],
    )
  ).rows;
  const other = await sources(
    tx,
    tenantId,
    'order_line',
    candidates.map((line) => line.id),
  );

  return {
    entity: {
      id: entityId,
      kind: 'order_line' as const,
      label: label(
        'order_line',
        '',
        facts.map((line) => line.source),
      ),
      orderId: first.orderId,
      unit: first.unit,
    },
    sources: facts.map((line) => line.source),
    suggestions: candidates.map((line) => ({
      id: line.id,
      label: label('order_line', '', other.get(line.id) ?? []),
      reason: 'Order line from another source on the linked order',
      sources: other.get(line.id) ?? [],
    })),
  };
}
