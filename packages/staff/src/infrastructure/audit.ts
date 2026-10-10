import type { PoolClient } from 'pg';

import type { AuditPage, AuditQuery } from '../application/audit.js';
import { auditPageSize } from '../application/audit.js';

/**
 * Reads one page of the staff audit through `staff_audit_entries`, which rechecks
 * `staff.audit.read` and owns the only read access to the table. `cursor` is a previous
 * page's `nextCursor`: the entry time with microseconds and its sequence number.
 */
export async function readStaffAudit(
  tx: PoolClient,
  query: AuditQuery,
): Promise<AuditPage> {
  const [beforeAt, beforeSequence] = query.cursor?.split('_') ?? [];
  const result = await tx.query<{
    sequence: string;
    created_at: Date;
    cursor: string;
    event: string;
    request_id: string;
    reason: string | null;
    outcome: 'succeeded' | 'failed';
    details: Record<string, unknown> | null;
    staff_user_id: string | null;
    staff_name: string | null;
    staff_email: string | null;
    workspace_id: string | null;
    workspace_name: string | null;
    account_id: string | null;
    account_name: string | null;
    account_email: string | null;
  }>('SELECT * FROM staff_audit_entries($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    query.staff ?? null,
    query.workspace ?? null,
    query.account ?? null,
    query.event ?? null,
    query.from ?? null,
    query.to ?? null,
    beforeAt ?? null,
    beforeSequence ?? null,
    auditPageSize + 1,
  ]);
  const page = result.rows.slice(0, auditPageSize);

  return {
    entries: page.map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at.toISOString(),
      event: row.event,
      outcome: row.outcome,
      requestId: row.request_id,
      reason: row.reason,
      details: row.details ?? {},
      staff: row.staff_user_id
        ? {
            id: row.staff_user_id,
            name: row.staff_name,
            email: row.staff_email,
          }
        : null,
      workspace: row.workspace_id
        ? { id: row.workspace_id, name: row.workspace_name }
        : null,
      account: row.account_id
        ? {
            id: row.account_id,
            name: row.account_name,
            email: row.account_email,
          }
        : null,
    })),
    nextCursor:
      result.rows.length > auditPageSize ? (page.at(-1)?.cursor ?? null) : null,
  };
}
