import type { AppEvidence } from '@luma/app-host';
import type { SqlTransaction } from '@luma/platform';
import { z } from 'zod';

const text = z.string().min(1).catch('').transform((value) => value || null);
const record = z.object({
  resource: z.string().min(1),
  externalId: z.string().min(1),
});

/**
 * The fields an update evidence document carries. Rows written before Luma recorded adapter
 * versions, completeness and accepted records lack them, so each one reads as null.
 */
const document = z.object({
  kind: z.string().optional().catch(undefined),
  orderId: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined),
  revision: text.optional(),
  adapterVersion: text.optional(),
  dispatchIdentity: text.optional(),
  completeness: z.enum(['complete', 'partial']).optional().catch(undefined),
  sourceUpdatedAt: z.string().datetime().nullish().catch(undefined),
  records: z.array(record).optional().catch(undefined),
});

/**
 * Reads the Starshipit order update evidence with these IDs. The table is not linked to the
 * citing record, so callers pass only IDs the record cites. An observation names the order, the
 * revision Luma derived from it and how it was read; an acceptance becomes a write receipt with
 * the records the response named.
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
    document: unknown;
  }>(
    `SELECT id::text,connection_id::text,observed_at,document FROM starshipit_order_update_evidence
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
    [tenantId, ids],
  );

  return rows.map(({ id, connection_id, observed_at, document: raw }) => {
    const parsed = document.safeParse(raw);
    const stored = parsed.success ? parsed.data : {};
    const evidence: AppEvidence =
      stored.kind === 'acceptance'
        ? {
            kind: 'write_receipt',
            id,
            provider: 'starshipit',
            connectionId: connection_id,
            capability: null,
            acceptedAt: observed_at.toISOString(),
            records: stored.records ?? [],
            providerRequestId: null,
            adapterVersion: stored.adapterVersion ?? null,
            dispatchIdentity: stored.dispatchIdentity ?? null,
          }
        : {
            kind: 'read',
            id,
            provider: 'starshipit',
            connectionId: connection_id,
            record: stored.orderId
              ? { resource: 'order', externalId: stored.orderId }
              : null,
            observedAt: observed_at.toISOString(),
            sourceUpdatedAt: stored.sourceUpdatedAt
              ? new Date(stored.sourceUpdatedAt).toISOString()
              : null,
            sourceRevision: stored.revision ?? null,
            adapterVersion: stored.adapterVersion ?? null,
            completeness: stored.completeness ?? null,
            data: raw,
          };

    return evidence;
  });
}
