import type { TenantDatabase } from '@luma/platform';

import type {
  ExecutionDependencies,
  ExecutionRecord,
  ObserveOnlyResult,
} from '../application/execution.js';

/** Reads owner-controlled modes and retains terminal observations without reserving an effect. */
export function createWriteControl(
  db: TenantDatabase,
): NonNullable<ExecutionDependencies['writeControl']> {
  return {
    mode: (tenantId, connectionId) =>
      db.transaction(tenantId, async (tx) => {
        const workspace = (
          await tx.query<{ write_mode: string }>(
            'SELECT write_mode FROM organizations WHERE id=$1',
            [tenantId],
          )
        ).rows[0];
        if (!workspace) throw new Error('Workspace write mode unavailable');
        const connection = (
          await tx.query<{ document: { writeMode?: string } }>(
            'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
            [tenantId, connectionId],
          )
        ).rows[0];

        return workspace.write_mode === 'observe_only' ||
          connection?.document.writeMode === 'observe_only'
          ? 'observe_only'
          : 'writes_enabled';
      }),
    get: (tenantId, proposalId) =>
      db.transaction(
        tenantId,
        async (tx) =>
          (
            await tx.query<{ document: ObserveOnlyResult }>(
              'SELECT document FROM execution_observe_only WHERE tenant_id=$1 AND proposal_id=$2',
              [tenantId, proposalId],
            )
          ).rows[0]?.document ?? null,
      ),
    record: (action, hash, result, event) =>
      db.transaction(action.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${action.tenantId}`,
        ]);
        const previous = (
          await tx.query<{ document: ExecutionRecord }>(
            'SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
            [action.tenantId, action.id],
          )
        ).rows[0]?.document;
        if (previous)
          return {
            state:
              previous.state === 'prepared' || previous.state === 'unknown'
                ? 'reconciliation_required'
                : previous.state,
            record: previous,
          };
        const inserted = await tx.query(
          'INSERT INTO execution_observe_only(tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING proposal_id',
          [action.tenantId, action.id, hash, result],
        );
        if (inserted.rowCount)
          await tx.query(
            'INSERT INTO execution_outbox(id,tenant_id,proposal_id,document) VALUES($1,$2,$3,$4)',
            [event.id, action.tenantId, action.id, event],
          );

        return (
          await tx.query<{ document: ObserveOnlyResult }>(
            'SELECT document FROM execution_observe_only WHERE tenant_id=$1 AND proposal_id=$2',
            [action.tenantId, action.id],
          )
        ).rows[0]!.document;
      }),
  };
}
