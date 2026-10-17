import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type {
  DraftTestStore,
  StoredDraftTestRun,
} from '../application/draft-tests.js';
import type { DraftTestCase } from '../domain/draft-test.js';

type RunRow = {
  document: StoredDraftTestRun;
  state: StoredDraftTestRun['state'];
  request_digest: string;
};

const interrupted = 'The test run was interrupted. Run it again.';

function present(row: RunRow): StoredDraftTestRun {
  return {
    ...row.document,
    state: row.state,
    requestDigest: row.request_digest,
  };
}

/**
 * Stores saved cases and actor-owned test runs under tenant RLS. Runs whose API process stopped
 * are marked failed once their deadline passes.
 */
export function createDraftTestStore(db: TenantDatabase): DraftTestStore {
  const expire = (tx: SqlTransaction, tenantId: string, draftId: string) =>
    tx.query(
      "UPDATE workflow_draft_test_runs SET state='failed',document=document || jsonb_build_object('state','failed','result',null,'error',$3::text) WHERE tenant_id=$1 AND draft_id=$2 AND state='running' AND expires_at < now()",
      [tenantId, draftId, interrupted],
    );

  return {
    cases: (context, draftId) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ revision: number; cases: DraftTestCase[] }>(
            'SELECT revision,cases FROM workflow_draft_tests WHERE tenant_id=$1 AND draft_id=$2',
            [context.tenantId, draftId],
          )
        ).rows[0];

        return row ?? { revision: 0, cases: [] };
      }),
    saveCases: (context, draftId, revision, cases) =>
      db.transaction(context.tenantId, async (tx) => {
        const values = [
          context.tenantId,
          draftId,
          revision,
          JSON.stringify(cases),
          context.actor.id,
        ];
        const row = (
          revision === 0
            ? await tx.query<{ revision: number; cases: DraftTestCase[] }>(
                'INSERT INTO workflow_draft_tests(tenant_id,draft_id,revision,cases,updated_by,updated_at) VALUES($1,$2,$3+1,$4,$5,now()) ON CONFLICT DO NOTHING RETURNING revision,cases',
                values,
              )
            : await tx.query<{ revision: number; cases: DraftTestCase[] }>(
                'UPDATE workflow_draft_tests SET revision=revision+1,cases=$4,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND draft_id=$2 AND revision=$3 RETURNING revision,cases',
                values,
              )
        ).rows[0];

        return row ?? null;
      }),
    get: (context, draftId, id) =>
      db.transaction(context.tenantId, async (tx) => {
        await expire(tx, context.tenantId, draftId);
        const row = (
          await tx.query<RunRow>(
            'SELECT document,state,request_digest FROM workflow_draft_test_runs WHERE tenant_id=$1 AND draft_id=$2 AND id=$3 AND principal_id=$4',
            [context.tenantId, draftId, id, context.actor.id],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    runs: (context, draftId, revision) =>
      db.transaction(context.tenantId, async (tx) => {
        await expire(tx, context.tenantId, draftId);
        const rows = await tx.query<RunRow>(
          'SELECT document,state,request_digest FROM workflow_draft_test_runs WHERE tenant_id=$1 AND draft_id=$2 AND draft_revision=$3 AND case_id IS NOT NULL ORDER BY created_at DESC,id LIMIT 500',
          [context.tenantId, draftId, revision],
        );

        return rows.rows.map(present);
      }),
    reserve: (context, draftId, item) =>
      db.transaction(context.tenantId, async (tx) => {
        const inserted = await tx.query(
          'INSERT INTO workflow_draft_test_runs(tenant_id,id,draft_id,draft_revision,case_id,principal_id,request_digest,state,document,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            item.id,
            draftId,
            item.revision,
            item.caseId,
            context.actor.id,
            item.requestDigest,
            item.state,
            item,
            item.createdAt,
            item.expiresAt,
          ],
        );
        if (inserted.rowCount === 1) return { item, created: true };
        const previous = (
          await tx.query<RunRow & { principal_id: string; draft_id: string }>(
            'SELECT document,state,request_digest,principal_id,draft_id FROM workflow_draft_test_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, item.id],
          )
        ).rows[0];
        if (
          !previous ||
          previous.request_digest !== item.requestDigest ||
          previous.principal_id !== context.actor.id ||
          previous.draft_id !== draftId
        )
          throw conflict(
            'This test run ID was already used with different inputs. Reuse the original request.',
          );

        return { item: present(previous), created: false };
      }),
    finish: (context, draftId, item) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "UPDATE workflow_draft_test_runs SET state=$5,document=$6 WHERE tenant_id=$1 AND draft_id=$2 AND id=$3 AND principal_id=$4 AND state='running' AND expires_at>now()",
          [
            context.tenantId,
            draftId,
            item.id,
            context.actor.id,
            item.state,
            item,
          ],
        );
      }),
    cancel: (context, draftId, id) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "UPDATE workflow_draft_test_runs SET state='cancelled',document=document || jsonb_build_object('state','cancelled') WHERE tenant_id=$1 AND draft_id=$2 AND id=$3 AND principal_id=$4 AND state='running'",
          [context.tenantId, draftId, id, context.actor.id],
        );
      }),
  };
}
