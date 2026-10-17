import type { AppEvidence } from '@luma/app-host';
import type { SqlTransaction } from '@luma/platform';
import { z } from 'zod';

const text = z.string().min(1).catch('').transform((value) => value || null);
const record = z.object({
  resource: z.string().min(1),
  externalId: z.string().min(1),
});

/**
 * The provenance fields a stored document carries. Rows written before Luma recorded them lack
 * these fields, so each one reads as null ("not recorded") instead of failing the row.
 */
const provenance = z.object({
  adapterVersion: text.optional(),
  dispatchIdentity: text.optional(),
  capability: text.optional(),
  completeness: z.enum(['complete', 'partial']).optional().catch(undefined),
  complete: z.boolean().optional().catch(undefined),
  sourceRevision: text.optional(),
  sourceUpdatedAt: z.string().datetime().optional().catch(undefined),
  record: record.optional().catch(undefined),
  records: z.array(record).optional().catch(undefined),
});

function provenanceOf(document: unknown) {
  const parsed = provenance.safeParse(document);

  return parsed.success ? parsed.data : {};
}

/**
 * Reads the Shopify corrections, order edits, fulfillment recoveries and shipment publishing
 * evidence with these IDs. The tables are not linked to the citing record, so callers pass only
 * IDs the record cites. Acceptances become write receipts and every other row a read. A read's
 * completeness is the one it recorded; older reads fall back to their own `complete` flag.
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
    const stored = provenanceOf(row.document);
    if (row.kind === 'acceptance')
      return {
        kind: 'write_receipt',
        id: row.id,
        provider: 'shopify',
        connectionId: row.connection_id,
        capability: stored.capability ?? null,
        acceptedAt: observedAt,
        records: stored.records ?? [],
        providerRequestId: null,
        adapterVersion: stored.adapterVersion ?? null,
        dispatchIdentity: stored.dispatchIdentity ?? null,
      };
    const complete = stored.complete ?? null;

    return {
      kind: 'read',
      id: row.id,
      provider: 'shopify',
      connectionId: row.connection_id,
      record: stored.record ?? null,
      observedAt,
      sourceUpdatedAt: stored.sourceUpdatedAt
        ? new Date(stored.sourceUpdatedAt).toISOString()
        : null,
      sourceRevision: stored.sourceRevision ?? null,
      adapterVersion: stored.adapterVersion ?? null,
      completeness:
        stored.completeness ??
        (complete === null ? null : complete ? 'complete' : 'partial'),
      data: row.document,
    };
  });
}
