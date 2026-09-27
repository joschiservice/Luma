import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { WorkflowTriggerStore } from '../application/triggers.js';
import type { WorkflowTriggerRun } from '../domain/workflow.js';
import { resolutionWorkflow } from '../domain/workflow.js';
import { compilePlaybook } from './playbooks/schema.js';
import { compileProcessWorkflow } from './process-schema.js';
import { compileWorkflow } from './workflow-schema.js';

type Row = {
  document: WorkflowTriggerRun;
  state: WorkflowTriggerRun['state'];
  triggered_at: Date | null;
};

function present(row: Row): WorkflowTriggerRun {
  return {
    ...row.document,
    state: row.state,
    triggeredAt: row.triggered_at?.toISOString() ?? null,
  };
}

/** Stores starts under tenant isolation. Unique source keys make concurrent retries safe. */
export function createWorkflowTriggerStore(
  db: TenantDatabase,
): WorkflowTriggerStore & {
  pending(context: TenantContext, id: string): Promise<WorkflowTriggerRun[]>;
} {
  return {
    pending: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<Row>(
          `SELECT r.document,r.state,r.triggered_at FROM workflow_trigger_runs r
        LEFT JOIN LATERAL (SELECT document FROM workflow_process_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id ORDER BY sequence DESC LIMIT 1) last ON true
        WHERE r.tenant_id=$1 AND r.definition_id=$2 AND r.state='awaiting_admission'
        AND (last.document IS NULL OR (last.document->>'state' IN ('waiting','completed') AND last.document->>'kind'<>'end'))
        ORDER BY r.document->>'createdAt',r.id`,
          [context.tenantId, id],
        );

        return rows.rows.map(present);
      }),
    version: (context, id, version) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ document: Record<string, unknown> }>(
            'SELECT document FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 AND version=$3',
            [context.tenantId, id, version],
          )
        ).rows[0];

        return row
          ? row.document.format === 'workflow/2'
            ? compileProcessWorkflow(row.document)
            : row.document.format === 'workflow/1'
              ? compileWorkflow(row.document)
              : resolutionWorkflow(compilePlaybook(row.document))
          : null;
      }),
    find: (context, key) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            'SELECT document,state,triggered_at FROM workflow_trigger_runs WHERE tenant_id=$1 AND dedupe_key=$2',
            [context.tenantId, key],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    run: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            'SELECT document,state,triggered_at FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    insert: (context, key, run) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state,due_at,triggered_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,dedupe_key) DO NOTHING`,
          [
            context.tenantId,
            run.id,
            run.definitionId,
            run.version,
            run.versionDigest,
            key,
            run.requestDigest,
            run,
            run.state,
            run.trigger.kind === 'schedule' ? run.trigger.at : null,
            run.triggeredAt,
          ],
        );
        const row = (
          await tx.query<Row>(
            'SELECT document,state,triggered_at FROM workflow_trigger_runs WHERE tenant_id=$1 AND dedupe_key=$2',
            [context.tenantId, key],
          )
        ).rows[0]!;

        return present(row);
      }),
    list: (context, id) =>
      db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<Row>(
          "SELECT document,state,triggered_at FROM workflow_trigger_runs WHERE tenant_id=$1 AND definition_id=$2 ORDER BY (document->>'createdAt')::timestamptz DESC,id DESC LIMIT 50",
          [context.tenantId, id],
        );

        return rows.rows.map(present);
      }),
    cancel: (context, id, runId) =>
      db.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            "UPDATE workflow_trigger_runs SET state='cancelled' WHERE tenant_id=$1 AND definition_id=$2 AND id=$3 AND state IN ('scheduled','cancelled') RETURNING document,state,triggered_at",
            [context.tenantId, id, runId],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
  };
}
