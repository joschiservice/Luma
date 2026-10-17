import type { SqlTransaction } from '@luma/platform';

/** A stored provider read of an order, in the shape the evidence view reads. */
interface OrderReadEvidence {
  kind: 'read';
  id: string;
  provider: string;
  connectionId: string;
  record: { resource: string; externalId: string } | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  adapterVersion: string | null;
  completeness: null;
  data: unknown;
}

/**
 * Finds the stored provider reads of orders with these observation IDs, such as the demand a
 * purchasing plan counted: the immutable order snapshot the read produced, with the source
 * record, read and source-update times, revision and adapter version of the observation behind
 * it. Callers pass only IDs a record cites. Customer details stay in the snapshot; the evidence
 * view gets only the status and the lines.
 */
export async function orderReadEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<OrderReadEvidence[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    connection_id: string;
    provider: string | null;
    resource: string | null;
    external_id: string | null;
    observed_at: Date;
    source_updated_at: Date | null;
    source_revision: string | null;
    adapter_version: string | null;
    status: string | null;
    lines: unknown;
  }>(
    `SELECT DISTINCT ON (s.observation_id) s.observation_id::text AS id,s.connection_id::text,
      COALESCE(o.document->'observation'->'source'->>'provider',c.document->>'provider',c.document->'target'->>'kind') AS provider,
      o.document->'observation'->'source'->>'resource' AS resource,
      o.document->'observation'->'source'->>'externalId' AS external_id,
      s.observed_at,s.source_updated_at,o.document->'observation'->>'sourceRevision' AS source_revision,
      COALESCE(o.document->'observation'->>'adapterVersion',s.normalizer_version) AS adapter_version,
      s.document->'data'->>'status' AS status,s.document->'data'->'lines' AS lines
     FROM orders_snapshots s
     LEFT JOIN connector_observations o ON o.tenant_id=s.tenant_id AND o.connection_id=s.connection_id AND o.id=s.observation_id
     LEFT JOIN connector_installations c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id
     WHERE s.tenant_id=$1 AND s.kind='order' AND s.observation_id=ANY($2::uuid[])
     ORDER BY s.observation_id,s.created_at DESC`,
    [tenantId, ids],
  );

  return rows.flatMap((row): OrderReadEvidence[] =>
    row.provider
      ? [
          {
            kind: 'read',
            id: row.id,
            provider: row.provider,
            connectionId: row.connection_id,
            record:
              row.resource && row.external_id
                ? { resource: row.resource, externalId: row.external_id }
                : null,
            observedAt: row.observed_at.toISOString(),
            sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null,
            sourceRevision: row.source_revision,
            adapterVersion: row.adapter_version,
            completeness: null,
            data: { status: row.status, lines: row.lines },
          },
        ]
      : [],
  );
}
