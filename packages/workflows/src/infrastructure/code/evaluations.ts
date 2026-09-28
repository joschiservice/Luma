import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { CodeEvaluationStore } from '../../application/code-evaluations.js';
import type { CodeEvaluation } from '../../domain/code-evaluation.js';

/** Reserves fixture evaluations atomically and expires jobs whose API process stopped. */
export function createCodeEvaluationStore(
  db: TenantDatabase,
): CodeEvaluationStore {
  return {
    get: (context, definitionId, id) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "UPDATE workflow_code_evaluations SET state='failed' WHERE tenant_id=$1 AND id=$2 AND state='running' AND expires_at < now()",
          [context.tenantId, id],
        );
        const row = (
          await tx.query<{
            document: CodeEvaluation;
            state: CodeEvaluation['state'];
          }>(
            'SELECT document,state FROM workflow_code_evaluations WHERE tenant_id=$1 AND definition_id=$2 AND id=$3 AND principal_id=$4',
            [context.tenantId, definitionId, id, context.actor.id],
          )
        ).rows[0];

        return row ? { ...row.document, state: row.state } : null;
      }),
    reserve: (context, definitionId, digest, item) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`code-evaluation:${context.tenantId}`],
        );
        const previous = (
          await tx.query<{
            document: CodeEvaluation;
            state: CodeEvaluation['state'];
            request_digest: string;
            principal_id: string;
            definition_id: string;
          }>(
            'SELECT * FROM workflow_code_evaluations WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, item.id],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.request_digest !== digest ||
            previous.principal_id !== context.actor.id ||
            previous.definition_id !== definitionId
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'This evaluation ID has different inputs. Reuse the original request.',
            );

          return {
            item: { ...previous.document, state: previous.state },
            created: false,
          };
        }
        const count = (
          await tx.query<{ count: string }>(
            "SELECT count(*) FROM workflow_code_evaluations WHERE tenant_id=$1 AND state='running' AND expires_at>now()",
            [context.tenantId],
          )
        ).rows[0];
        if (Number(count?.count) >= 2)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Two evaluations are already running. Wait or cancel one.',
          );
        await tx.query(
          'INSERT INTO workflow_code_evaluations(tenant_id,id,definition_id,version,principal_id,request_digest,state,document,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            context.tenantId,
            item.id,
            definitionId,
            item.version,
            context.actor.id,
            digest,
            item.state,
            item,
            item.expiresAt,
          ],
        );

        return { item, created: true };
      }),
    finish: (context, definitionId, item) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "UPDATE workflow_code_evaluations SET state=$5,document=$6 WHERE tenant_id=$1 AND definition_id=$2 AND id=$3 AND principal_id=$4 AND state='running' AND expires_at>now()",
          [
            context.tenantId,
            definitionId,
            item.id,
            context.actor.id,
            item.state,
            item,
          ],
        );
      }),
    cancel: (context, definitionId, id) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "UPDATE workflow_code_evaluations SET state='cancelled' WHERE tenant_id=$1 AND definition_id=$2 AND id=$3 AND principal_id=$4 AND state='running'",
          [context.tenantId, definitionId, id, context.actor.id],
        );
      }),
  };
}
