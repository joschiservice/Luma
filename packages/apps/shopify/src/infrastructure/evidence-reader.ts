import type { AppEvidence } from '@luma/app-host';
import type { SqlTransaction } from '@luma/platform';

/**
 * Reads the Shopify corrections, order edits, fulfillment recoveries and shipment publishing
 * evidence with these IDs. The tables are not linked to the citing record, so callers pass only
 * IDs the record cites. Acceptances become write receipts and every other row a read; a read's
 * completeness comes from its own `complete` flag when it recorded one.
 */
export async function readShopifyEvidence(
  tx: SqlTransaction,
  tenantId: string,
  ids: string[],
): Promise<AppEvidence[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    connection_id: string;
    kind: string;
    observed_at: Date;
    document: unknown;
  }>(
    `SELECT id::text,connection_id::text,kind,observed_at,document FROM shopify_inventory_evidence
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,connection_id::text,kind,observed_at,document FROM shopify_order_edit_evidence
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,connection_id::text,kind,observed_at,document FROM shopify_fulfillment_evidence
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])
     UNION ALL SELECT id::text,connection_id::text,kind,observed_at,document FROM shopify_shipment_evidence
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, ids],
  );

  return rows.map((row): AppEvidence => {
    const observedAt = row.observed_at.toISOString();
    if (row.kind === 'acceptance')
      return {
        kind: 'write_receipt',
        id: row.id,
        provider: 'shopify',
        connectionId: row.connection_id,
        capability: null,
        acceptedAt: observedAt,
        records: [],
        providerRequestId: null,
      };
    const complete =
      row.document &&
      typeof row.document === 'object' &&
      'complete' in row.document &&
      typeof row.document.complete === 'boolean'
        ? row.document.complete
        : null;

    return {
      kind: 'read',
      id: row.id,
      provider: 'shopify',
      connectionId: row.connection_id,
      record: null,
      observedAt,
      sourceUpdatedAt: null,
      sourceRevision: null,
      adapterVersion: null,
      completeness:
        complete === null ? null : complete ? 'complete' : 'partial',
      data: row.document,
    };
  });
}
