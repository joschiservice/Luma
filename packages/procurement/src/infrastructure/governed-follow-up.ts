import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type {
  FollowUpPlan,
  FollowUpPlanStore,
} from '../application/governed-follow-up.js';

/** Persists immutable note proposals with a stable logical receipt across explicit renewal. */
export function createFollowUpPlanStore(db: TenantDatabase): FollowUpPlanStore {
  const get = (context: Parameters<FollowUpPlanStore['get']>[0], id: string) =>
    db.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{ document: FollowUpPlan }>(
            'SELECT document FROM procurement_follow_up_plans WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, id],
          )
        ).rows[0]?.document ?? null,
    );

  return {
    get,
    head: (context, runId) =>
      db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ document: FollowUpPlan }>(
              'SELECT p.document FROM procurement_follow_up_heads h JOIN procurement_follow_up_plans p ON p.tenant_id=h.tenant_id AND p.id=h.proposal_id WHERE h.tenant_id=$1 AND h.workflow_run_id=$2',
              [context.tenantId, runId],
            )
          ).rows[0]?.document ?? null,
      ),
    create: (context, plan) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${context.tenantId}`,
        ]);
        const existing = (
          await tx.query<{ document: FollowUpPlan }>(
            'SELECT p.document FROM procurement_follow_up_heads h JOIN procurement_follow_up_plans p ON p.tenant_id=h.tenant_id AND p.id=h.proposal_id WHERE h.tenant_id=$1 AND h.workflow_run_id=$2',
            [context.tenantId, plan.workflowRunId],
          )
        ).rows[0]?.document;
        if (existing) return existing;
        await tx.query(
          'INSERT INTO procurement_follow_up_plans(tenant_id,id,workflow_run_id,order_id,document) VALUES($1,$2,$3,$4,$5)',
          [context.tenantId, plan.id, plan.workflowRunId, plan.orderId, plan],
        );
        await tx.query(
          'INSERT INTO procurement_follow_up_heads(tenant_id,workflow_run_id,proposal_id) VALUES($1,$2,$3)',
          [context.tenantId, plan.workflowRunId, plan.id],
        );

        return plan;
      }),
    renew: (context, previous, next, commandId) =>
      db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${context.tenantId}`,
        ]);
        const prior = (
          await tx.query<{
            document: FollowUpPlan;
            previous_id: string;
            actor_id: string;
          }>(
            'SELECT document,previous_id,actor_id FROM procurement_follow_up_renewals WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, commandId],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.previous_id !== previous.id ||
            prior.actor_id !== context.actor.id
          )
            throw conflict('Renewal command is bound to another review.');

          return prior.document;
        }
        const head = (
          await tx.query<{ proposal_id: string }>(
            'SELECT proposal_id FROM procurement_follow_up_heads WHERE tenant_id=$1 AND workflow_run_id=$2',
            [context.tenantId, previous.workflowRunId],
          )
        ).rows[0];
        if (head?.proposal_id !== previous.id)
          throw conflict('Proposal was already renewed. Refresh the review.');
        // Deliberate cross-owner safety read under the same dispatch fence. Any reserved or
        // uncertain attempt must reconcile first; a known withheld attempt can be reviewed anew.
        const attempt = (
          await tx.query<{
            document: { state: string; attempt: { dispatch?: string } };
          }>(
            'SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
            [context.tenantId, previous.id],
          )
        ).rows[0]?.document;
        if (
          attempt &&
          !(
            attempt.state !== 'prepared' &&
            attempt.attempt.dispatch === 'not_dispatched'
          )
        )
          throw conflict(
            'This proposal has a reserved or dispatched attempt. Reconcile it before renewal.',
          );
        await tx.query(
          'INSERT INTO procurement_follow_up_plans(tenant_id,id,workflow_run_id,order_id,document) VALUES($1,$2,$3,$4,$5)',
          [context.tenantId, next.id, next.workflowRunId, next.orderId, next],
        );
        await tx.query(
          'UPDATE procurement_follow_up_heads SET proposal_id=$3 WHERE tenant_id=$1 AND workflow_run_id=$2',
          [context.tenantId, next.workflowRunId, next.id],
        );
        await tx.query(
          'INSERT INTO procurement_follow_up_renewals(tenant_id,id,previous_id,actor_id,document) VALUES($1,$2,$3,$4,$5)',
          [context.tenantId, commandId, previous.id, context.actor.id, next],
        );

        return next;
      }),
    pending: (context) =>
      db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: FollowUpPlan }>(
            "SELECT p.document FROM procurement_follow_up_heads h JOIN procurement_follow_up_plans p ON p.tenant_id=h.tenant_id AND p.id=h.proposal_id WHERE h.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM executed_actions e WHERE e.tenant_id=p.tenant_id AND e.proposal_id=p.id AND e.document->'attempt'->>'businessOutcome'='satisfied') ORDER BY p.created_at DESC,p.id LIMIT 100",
            [context.tenantId],
          )
        ).rows.map((row) => row.document),
      ),
  };
}
