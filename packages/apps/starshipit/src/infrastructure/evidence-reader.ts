import type { AppEvidence } from '@luma/app-host';
import type { SqlTransaction } from '@luma/platform';

interface UpdateEvidenceDocument {
  kind?: string;
  orderId?: unknown;
  revision?: unknown;
}

/**
 * Reads the Starshipit order update evidence with these IDs. The table is not linked to the
 * citing record, so callers pass only IDs the record cites. An observation names the order and
 * the revision Luma derived from it; an acceptance becomes a write receipt.
 */
export async function readStarshipitEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<AppEvidence[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    connection_id: string;
    observed_at: Date;
    document: UpdateEvidenceDocument;
  }>(
    `SELECT id::text,connection_id::text,observed_at,document FROM starshipit_order_update_evidence
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, ids],
  );

  return rows.map(
    ({ id, connection_id, observed_at, document }): AppEvidence =>
      document.kind === 'acceptance'
        ? {
            kind: 'write_receipt',
            id,
            provider: 'starshipit',
            connectionId: connection_id,
            capability: null,
            acceptedAt: observed_at.toISOString(),
            records: [],
            providerRequestId: null,
          }
        : {
            kind: 'read',
            id,
            provider: 'starshipit',
            connectionId: connection_id,
            record:
              typeof document.orderId === 'string' ||
              typeof document.orderId === 'number'
                ? { resource: 'order', externalId: String(document.orderId) }
                : null,
            observedAt: observed_at.toISOString(),
            sourceUpdatedAt: null,
            sourceRevision:
              typeof document.revision === 'string' ? document.revision : null,
            adapterVersion: null,
            completeness: null,
            data: document,
          },
  );
}
