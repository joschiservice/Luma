import type { AuditLog } from '@luma/audit';
import type { TenantDatabase } from '@luma/platform';

import type { ReturnDeadlineStore } from '../application/return-deadlines.js';
import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type { ExchangeStep } from '../domain/return-exchanges.js';
import type {
  ReturnDeadlinePolicy,
  ReturnWaitEpisode,
} from '../domain/return-waiting.js';

/** Persists merchant policy versions, a bounded monitor cursor and durable case waiting occurrences. */
export function createReturnDeadlineStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): ReturnDeadlineStore {
  return {
    transaction: (tenantId, fn) =>
      db.transaction(tenantId, async (tx) => {
        const log = audit({ transaction: async (_tenant, op) => op(tx) });
        const documents = async <T>(sql: string, params: unknown[]) =>
          (await tx.query<{ document: T }>(sql, params)).rows.map(
            (r) => r.document,
          );

        return fn({
          policy: async () =>
            (
              await documents<ReturnDeadlinePolicy>(
                'SELECT document FROM orders_return_deadline_policies WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 1',
                [tenantId],
              )
            )[0] ?? null,
          policyCommand: async (id) =>
            (
              await tx.query<{ digest: string; policy: ReturnDeadlinePolicy }>(
                'SELECT digest,document AS policy FROM orders_return_deadline_policies WHERE tenant_id=$1 AND command_id=$2',
                [tenantId, id],
              )
            ).rows[0] ?? null,
          insertPolicy: async (policy, commandId, digest) => {
            await tx.query(
              'INSERT INTO orders_return_deadline_policies(tenant_id,revision,command_id,digest,document) VALUES($1,$2,$3,$4,$5)',
              [tenantId, policy.revision, commandId, digest, policy],
            );
          },
          lockPolicy: async () => {
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`return-deadlines:${tenantId}`],
            );
          },
          case: async (id, lock = false) => {
            if (lock) {
              const c = (
                await documents<ReturnCase>(
                  'SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2',
                  [tenantId, id],
                )
              )[0];
              if (!c) return null;
              await tx.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [`orders-return-cases:${tenantId}:${c.orderId}`],
              );
            }

            return (
              (
                await documents<ReturnCase>(
                  `SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
                  [tenantId, id],
                )
              )[0] ?? null
            );
          },
          batch: (limit, checkedBefore) =>
            documents<ReturnCase>(
              `SELECT document FROM orders_return_cases WHERE tenant_id=$1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM orders_return_deadline_checks w WHERE w.tenant_id=orders_return_cases.tenant_id AND w.case_id=orders_return_cases.id AND w.policy_revision=(SELECT max(revision) FROM orders_return_deadline_policies WHERE tenant_id=$1) AND w.checked_at >= $3::timestamptz)
        AND (id>COALESCE((SELECT last_case_id FROM orders_return_deadline_cursors WHERE tenant_id=$1),'00000000-0000-0000-0000-000000000000'::uuid)) ORDER BY id LIMIT $2`,
              [tenantId, limit, checkedBefore],
            ),
          checked: async (caseId, revision, at) => {
            await tx.query(
              'INSERT INTO orders_return_deadline_checks(tenant_id,case_id,policy_revision,checked_at) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,case_id) DO UPDATE SET policy_revision=EXCLUDED.policy_revision,checked_at=EXCLUDED.checked_at',
              [tenantId, caseId, revision, at],
            );
          },
          checkpoint: async (id) => {
            await tx.query(
              'INSERT INTO orders_return_deadline_cursors(tenant_id,last_case_id) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET last_case_id=EXCLUDED.last_case_id',
              [tenantId, id],
            );
          },
          refund: async (caseId) =>
            (
              await documents<ReturnAction>(
                "SELECT document FROM orders_return_actions WHERE tenant_id=$1 AND case_id=$2 AND kind='refund' ORDER BY sent DESC,requested_at DESC,id DESC LIMIT 1",
                [tenantId, caseId],
              )
            )[0] ?? null,
          exchange: async (caseId) =>
            (
              await documents<ExchangeStep>(
                "SELECT document FROM orders_return_exchange_steps WHERE tenant_id=$1 AND case_id=$2 AND kind='process' ORDER BY sent DESC,requested_at DESC,id DESC LIMIT 1",
                [tenantId, caseId],
              )
            )[0] ?? null,
          episodes: (caseId) =>
            documents<ReturnWaitEpisode>(
              'SELECT document FROM orders_return_waits WHERE tenant_id=$1 AND case_id=$2 ORDER BY opened_at DESC,id LIMIT 501',
              [tenantId, caseId],
            ),
          episode: async (id) =>
            (
              await documents<ReturnWaitEpisode>(
                'SELECT document FROM orders_return_waits WHERE tenant_id=$1 AND id=$2',
                [tenantId, id],
              )
            )[0] ?? null,
          openEpisodes: (limit) =>
            documents<ReturnWaitEpisode>(
              `SELECT w.document || jsonb_build_object('ownerId',COALESCE(c.document->>'assigneeId',c.document->>'openedBy')) AS document
        FROM orders_return_waits w JOIN orders_return_cases c ON c.tenant_id=w.tenant_id AND c.id=w.case_id
        WHERE w.tenant_id=$1 AND c.state='open' AND w.state IN ('waiting','escalated')
        AND w.policy_revision=(SELECT max(revision) FROM orders_return_deadline_policies WHERE tenant_id=$1)
        AND (SELECT (document->>'enabled')::boolean FROM orders_return_deadline_policies WHERE tenant_id=$1 ORDER BY revision DESC LIMIT 1)
        ORDER BY w.due_at,w.id LIMIT $2`,
              [tenantId, limit],
            ),
          save: async (v) => {
            await tx.query(
              `INSERT INTO orders_return_waits(tenant_id,id,case_id,phase,policy_revision,state,document,opened_at,due_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,id) DO UPDATE SET state=EXCLUDED.state,document=EXCLUDED.document`,
              [
                tenantId,
                v.id,
                v.caseId,
                v.phase,
                v.policyRevision,
                v.state,
                v,
                v.openedAt,
                v.dueAt,
              ],
            );
          },
          audit: log.append,
        });
      }),
  };
}
