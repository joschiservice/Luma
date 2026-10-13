import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Reads admitted field workflows without changing workflow or policy-owned tables. */
export function createFieldsWorkflowQueries(db: TenantDatabase) {
  return {
    pending: (context: TenantContext) =>
      db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ run_id: string; step_id: string }>(
            `SELECT s.run_id,s.step_id FROM action_admission_steps s
      JOIN workflow_trigger_runs r ON r.tenant_id=s.tenant_id AND r.id=s.run_id
      JOIN LATERAL (SELECT d.* FROM policy_decisions d WHERE d.tenant_id=s.tenant_id AND d.proposal_id=s.proposal_id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) d ON true
      WHERE s.tenant_id=$1 AND s.document->'subject'->>'kind'='adaptive_field_change' AND r.state='awaiting_admission' AND d.document->>'outcome'='approval_required'
      AND NOT EXISTS(SELECT 1 FROM policy_approvals a WHERE a.tenant_id=d.tenant_id AND a.proposal_id=d.proposal_id AND a.action_hash=d.action_hash AND a.policy_version=d.document->>'policyVersion')
      ORDER BY s.created_at DESC,s.run_id,s.step_id LIMIT 100`,
            [context.tenantId],
          )
        ).rows.map((row) => ({ runId: row.run_id, stepId: row.step_id })),
      ),
    latestDecisionId: (context: TenantContext, proposalId: string) =>
      db.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM policy_decisions WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
              [context.tenantId, proposalId],
            )
          ).rows[0]?.id ?? null,
      ),
  };
}
