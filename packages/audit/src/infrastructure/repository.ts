import type { TenantDatabase } from '@luma/platform';

import type { AuditEntry, AuditLog } from '../application/audit.js';

/** Creates a tenant-scoped, append-only audit log with idempotent event keys. */
export function createAuditLog(db: TenantDatabase): AuditLog {
  return {
    append: (entry) =>
      db.transaction(entry.tenantId, async (tx) => {
        // Concurrent replays can collide on the primary key as well as the event key.
        // Accept a duplicate only when the stored evidence matches below.
        await tx.query(
          'INSERT INTO audit_entries(id, tenant_id, event_key, proposal_id, document) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [entry.id, entry.tenantId, entry.eventKey, entry.proposalId, entry],
        );
        const result = await tx.query<{ matches: boolean }>(
          'SELECT document = $3::jsonb AS matches FROM audit_entries WHERE tenant_id=$1 AND event_key=$2',
          [entry.tenantId, entry.eventKey, entry],
        );
        if (!result.rows[0]?.matches)
          throw new Error('Audit event key conflicts with existing evidence');
      }),
    list: (tenantId, proposalId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: AuditEntry }>(
          'SELECT document FROM audit_entries WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at, id',
          [tenantId, proposalId],
        );

        return result.rows.map((row) => row.document);
      }),
  };
}
