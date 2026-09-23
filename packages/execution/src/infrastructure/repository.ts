import type { AuditEntry } from '@luma/audit';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  ExecutionRecord,
  ExecutionRepository,
} from '../application/execution.js';

async function outbox(tx: SqlTransaction, entry: AuditEntry) {
  await tx.query(
    'INSERT INTO execution_outbox(id, tenant_id, proposal_id, document) VALUES ($1,$2,$3,$4)',
    [entry.id, entry.tenantId, entry.proposalId, entry],
  );
}

/**
 * Creates tenant-scoped action, attempt, and reconciliation storage with concurrency
 * control.
 */
export function createExecutionRepository(
  db: TenantDatabase,
): ExecutionRepository {
  return {
    verification: (tenantId, entry) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO execution_verifications(tenant_id,id,proposal_id,phase,document) VALUES($1,$2,$3,$4,$5)',
          [tenantId, entry.id, entry.proposalId, entry.phase, entry],
        );
      }),
    failure: (tenantId, entry) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO execution_failures(tenant_id,id,proposal_id,document) VALUES($1,$2,$3,$4)',
          [tenantId, entry.id, entry.proposalId, entry],
        );
      }),
    bindIntent: (action, hash) =>
      db.transaction(action.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO execution_intents(id,tenant_id,action_hash,document) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,id) DO NOTHING',
          [action.id, action.tenantId, hash, action],
        );
        const result = await tx.query<{ action_hash: string }>(
          'SELECT action_hash FROM execution_intents WHERE tenant_id=$1 AND id=$2',
          [action.tenantId, action.id],
        );
        if (result.rows[0]?.action_hash !== hash)
          throw new Error('Idempotency key conflicts with existing intent');
      }),
    get: (tenantId, proposalId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: ExecutionRecord }>(
          'SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
          [tenantId, proposalId],
        );

        return result.rows[0]?.document ?? null;
      }),
    prepare: (record, entry) =>
      db.transaction(record.tenantId, async (tx) => {
        // Concurrent reservations can conflict on either proposal or idempotency identity.
        const result = await tx.query(
          'INSERT INTO executed_actions(id, tenant_id, proposal_id, idempotency_key, action_hash, state, document) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
          [
            record.id,
            record.tenantId,
            record.proposalId,
            record.idempotencyKey,
            record.actionHash,
            record.state,
            record,
          ],
        );
        if (!result.rowCount) return false;
        await outbox(tx, entry);

        return true;
      }),
    finish: (record, expectedState, entry) =>
      db.transaction(record.tenantId, async (tx) => {
        const result = await tx.query(
          'UPDATE executed_actions SET state=$4, document=$5, updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2 AND state=$3 RETURNING id',
          [
            record.tenantId,
            record.proposalId,
            expectedState,
            record.state,
            record,
          ],
        );
        if (!result.rowCount) return false;
        await outbox(tx, entry);

        return true;
      }),
    pending: (tenantId, proposalId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: AuditEntry }>(
          'SELECT document FROM execution_outbox WHERE tenant_id=$1 AND proposal_id=$2 AND delivered_at IS NULL ORDER BY created_at, id',
          [tenantId, proposalId],
        );

        return result.rows.map((row) => row.document);
      }),
    delivered: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'UPDATE execution_outbox SET delivered_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
      }),
  };
}
