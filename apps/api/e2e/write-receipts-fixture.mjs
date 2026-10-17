import { expect } from 'vitest';

/** Provider writes whose receipts the owner that binds them stores. */
const ownerStored = [
  'purchase-orders.submit',
  'purchase-orders.revise',
  'returns.create',
  'returns.refund',
  'returns.restock',
  'returns.exchange.request',
  'returns.exchange.process',
  'returns.exchange.cancel',
  'returns.exchange.release',
  'messages.send',
];

/**
 * The write receipts a workspace's provider writes cite, per execution attempt: the references
 * the attempt and its completion audit entry cite, and the receipts stored for the attempt's
 * idempotency key in procurement, orders and messaging evidence. `proposalIds` limits it to
 * those actions.
 */
async function writeReceipts(db, tenantId, proposalIds = null) {
  const attempts = await db.query(
    `SELECT e.proposal_id::text AS proposal_id,e.document->'intent'->>'capability' AS capability,
       COALESCE(e.document->'attempt'->'effectEvidenceRefs','[]'::jsonb) AS cited,
       COALESCE((SELECT jsonb_agg(r) FROM audit_entries a,jsonb_array_elements_text(a.document->'evidenceRefs') r
         WHERE a.tenant_id=e.tenant_id AND a.proposal_id=e.proposal_id
           AND a.document->>'eventType'='execution.completed'),'[]'::jsonb) AS audited
     FROM executed_actions e
     WHERE e.tenant_id=$1 AND e.document->'intent'->>'capability'=ANY($2::text[])
       AND ($3::uuid[] IS NULL OR e.proposal_id=ANY($3::uuid[]))
     ORDER BY e.proposal_id`,
    [tenantId, ownerStored, proposalIds],
  );
  const stored = await db.query(
    `SELECT id::text,'procurement' AS owner,document FROM procurement_read_evidence
       WHERE tenant_id=$1 AND kind='write_receipt'
     UNION ALL SELECT id::text,'orders',document FROM orders_return_read_evidence
       WHERE tenant_id=$1 AND kind='write_receipt'
     UNION ALL SELECT id::text,'messaging',document FROM messaging_send_receipts
       WHERE tenant_id=$1`,
    [tenantId],
  );

  return attempts.rows.map((attempt) => ({
    ...attempt,
    stored: stored.rows.filter(
      (row) =>
        attempt.cited.includes(row.id) ||
        row.document.idempotencyKey === `v0:${attempt.proposal_id}`,
    ),
  }));
}

/**
 * Asserts that every write receipt the attempts and their completion audit cite resolves to
 * exactly one stored receipt for that attempt, and that no receipt is stored without being
 * cited. Returns the attempts, so a journey can check how many were accepted.
 */
export async function expectStoredWriteReceipts(
  db,
  tenantId,
  proposalIds = null,
) {
  const attempts = await writeReceipts(db, tenantId, proposalIds);
  for (const attempt of attempts) {
    expect(attempt.cited.length).toBeLessThanOrEqual(1);
    for (const ref of attempt.cited) expect(attempt.audited).toContain(ref);
    expect(attempt.stored.map((row) => row.id)).toEqual(attempt.cited);
    for (const row of attempt.stored)
      expect(row.document).toMatchObject({
        kind: 'write_receipt',
        id: row.id,
        status: 'accepted',
        capability: attempt.capability,
        idempotencyKey: `v0:${attempt.proposal_id}`,
        source: { connectionId: expect.any(String) },
      });
  }

  return attempts;
}
