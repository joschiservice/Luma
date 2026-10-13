import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import type { WorkflowTriggerStore } from '../application/triggers.js';
import type {
  WorkflowSubscription,
  WorkflowTriggerRun,
} from '../domain/workflow.js';
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
    subscription: (context, id) =>
      db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ document: WorkflowSubscription }>(
              'SELECT document FROM workflow_subscription_heads h JOIN workflow_subscription_revisions r USING(tenant_id,id,revision) WHERE h.tenant_id=$1 AND h.id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.document ?? null,
      ),
    subscriptions: (context, id) =>
      db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: WorkflowSubscription }>(
            'SELECT r.document FROM workflow_subscription_heads h JOIN workflow_subscription_revisions r USING(tenant_id,id,revision) WHERE h.tenant_id=$1 AND r.definition_id=$2 ORDER BY h.id LIMIT 100',
            [context.tenantId, id],
          )
        ).rows.map((row) => row.document),
      ),
    saveSubscription: (context, input, expected) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `workflow-subscription:${context.tenantId}:${input.id}`,
        ]);
        const head = (
          await tx.query<{ revision: number }>(
            'SELECT revision FROM workflow_subscription_heads WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, input.id],
          )
        ).rows[0];
        if ((head?.revision ?? 0) !== expected) {
          const prior = (
            await tx.query<{ document: WorkflowSubscription }>(
              'SELECT document FROM workflow_subscription_revisions WHERE tenant_id=$1 AND id=$2 AND revision=$3',
              [context.tenantId, input.id, input.revision],
            )
          ).rows[0]?.document;
          if (
            prior &&
            canonicalJson({ ...prior, updatedAt: input.updatedAt }) ===
              canonicalJson(input)
          )
            return prior;
          throw new IdentityError(
            409,
            'CONFLICT',
            'This subscription changed. Refresh before saving.',
          );
        }
        if (
          head &&
          !(
            await tx.query(
              'SELECT 1 FROM workflow_subscription_revisions WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND definition_id=$4',
              [context.tenantId, input.id, head.revision, input.definitionId],
            )
          ).rowCount
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'Subscription belongs to another workflow.',
          );
        await tx.query(
          'INSERT INTO workflow_subscription_revisions(tenant_id,id,revision,definition_id,document) VALUES($1,$2,$3,$4,$5)',
          [
            context.tenantId,
            input.id,
            input.revision,
            input.definitionId,
            input,
          ],
        );
        await tx.query(
          'INSERT INTO workflow_subscription_heads(tenant_id,id,revision) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO UPDATE SET revision=EXCLUDED.revision',
          [context.tenantId, input.id, input.revision],
        );

        return input;
      }),
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
            'SELECT v.document FROM playbook_versions v WHERE v.tenant_id=$1 AND v.definition_id=$2 AND v.version=$3 AND NOT EXISTS(SELECT 1 FROM workflow_package_archives a WHERE a.tenant_id=v.tenant_id AND a.definition_id=v.definition_id AND a.archived)',
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
        if (run.subscription) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `workflow-subscription:${context.tenantId}:${run.subscription.id}`,
          ]);
          const head = (
            await tx.query<{ document: WorkflowSubscription }>(
              'SELECT r.document FROM workflow_subscription_heads h JOIN workflow_subscription_revisions r USING(tenant_id,id,revision) WHERE h.tenant_id=$1 AND h.id=$2',
              [context.tenantId, run.subscription.id],
            )
          ).rows[0]?.document;
          if (
            !head?.active ||
            canonicalJson(head) !== canonicalJson(run.subscription)
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'Subscription changed before this start. Refresh and retry.',
            );
        }
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
        // Admission binds first steps under this fence before dispatch. A missing
        // process output alone does not establish that no action was admitted.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `workflow-run:${context.tenantId}:${runId}`,
        ]);
        const row = (
          await tx.query<Row>(
            "UPDATE workflow_trigger_runs SET state='cancelled' WHERE tenant_id=$1 AND definition_id=$2 AND id=$3 AND (state IN ('scheduled','cancelled') OR (state='awaiting_admission' AND ((NOT EXISTS(SELECT 1 FROM workflow_process_steps untouched WHERE untouched.tenant_id=workflow_trigger_runs.tenant_id AND untouched.run_id=workflow_trigger_runs.id) AND EXISTS(SELECT 1 FROM playbook_versions v WHERE v.tenant_id=workflow_trigger_runs.tenant_id AND v.definition_id=workflow_trigger_runs.definition_id AND v.version=workflow_trigger_runs.version AND v.document->>'format'='workflow/2') AND NOT EXISTS(SELECT 1 FROM action_admission_steps bound WHERE bound.tenant_id=workflow_trigger_runs.tenant_id AND bound.run_id=workflow_trigger_runs.id) AND NOT EXISTS(SELECT 1 FROM executed_actions execution WHERE execution.tenant_id=workflow_trigger_runs.tenant_id AND execution.document->'admission'->>'runId'=workflow_trigger_runs.id::text)) OR (SELECT waiting.state='waiting' AND waiting.document->>'kind' IN ('human_task','event_wait') FROM workflow_process_steps waiting WHERE waiting.tenant_id=workflow_trigger_runs.tenant_id AND waiting.run_id=workflow_trigger_runs.id ORDER BY waiting.sequence DESC LIMIT 1)) AND NOT EXISTS(SELECT 1 FROM workflow_process_steps s WHERE s.tenant_id=workflow_trigger_runs.tenant_id AND s.run_id=workflow_trigger_runs.id AND (s.document->>'kind'='end' OR s.state IN ('denied','failed','inconclusive','ended','escalated'))))) RETURNING document,state,triggered_at",
            [context.tenantId, id, runId],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
  };
}
