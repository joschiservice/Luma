import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson, conflict } from '@luma/platform';

import type { CaseActivationStore } from '../application/case-workflows.js';
import type { CaseActivation } from '../domain/case-workflow.js';

type Row = {
  document: CaseActivation;
  active: boolean;
  revoked_at: Date | null;
  revoked_by: string | null;
};

const present = (row: Row): CaseActivation => ({
  ...row.document,
  active: row.active,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revokedBy: row.revoked_by,
});

/** Persists case workflow activations under tenant row-level security. */
export function createCaseActivationStore(
  db: TenantDatabase,
): CaseActivationStore {
  return {
    list: (context: TenantContext) =>
      db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<Row>(
            'SELECT document,active,revoked_at,revoked_by FROM workflow_case_activations WHERE tenant_id=$1 ORDER BY created_at DESC,id',
            [context.tenantId],
          )
        ).rows.map(present),
      ),
    insert: (context, activation) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `case-workflow:${context.tenantId}:${activation.definitionId}`,
        ]);
        const existing = (
          await tx.query<Row>(
            'SELECT document,active,revoked_at,revoked_by FROM workflow_case_activations WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, activation.id],
          )
        ).rows[0];
        if (existing) {
          if (
            canonicalJson({ ...existing.document, reviewedAt: '' }) !==
            canonicalJson({
              ...activation,
              reviewedAt: '',
              active: true,
              revokedAt: null,
              revokedBy: null,
            })
          )
            throw conflict('This activation ID belongs to another request.');

          return present(existing);
        }
        const overlap = await tx.query(
          'SELECT id FROM workflow_case_activations WHERE tenant_id=$1 AND definition_id=$2 AND active',
          [context.tenantId, activation.definitionId],
        );
        if (overlap.rowCount)
          throw conflict(
            'This workflow is already on. Turn it off before turning it on for someone else.',
          );
        const document = {
          ...activation,
          active: true,
          revokedAt: null,
          revokedBy: null,
        };
        await tx.query(
          'INSERT INTO workflow_case_activations(tenant_id,id,definition_id,principal_id,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            activation.id,
            activation.definitionId,
            activation.principalId,
            document,
            activation.reviewedAt,
          ],
        );

        return document;
      }),
    revoke: (context, id, actorId, at) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            'UPDATE workflow_case_activations SET active=false,revoked_at=COALESCE(revoked_at,$4::timestamptz),revoked_by=COALESCE(revoked_by,$3) WHERE tenant_id=$1 AND id=$2 RETURNING document,active,revoked_at,revoked_by',
            [context.tenantId, id, actorId, at],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
  };
}
