import type { SqlTransaction } from '@luma/platform';

import type { DeskSnapshot } from '../../application/desk.js';

/** Persisted case provenance; labels and matching subjects alone never associate a workflow. */
const caseWorkflowRuns = `SELECT r.id FROM workflow_trigger_runs r WHERE r.tenant_id=$1
 AND r.document->'context'->'inputs'->>'caseId'=$2::text`;

/** Action IDs recorded by capability steps of the explicitly associated case runs. */
export const caseWorkflowProposals = `SELECT DISTINCT (s.document->'values'->>'proposalId')::uuid AS id
 FROM workflow_process_steps s WHERE s.tenant_id=$1 AND s.run_id IN (${caseWorkflowRuns})
 AND s.document->>'kind'='capability'
 AND s.document->'values'->>'proposalId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/** Reads bounded owner records without providers, models, policy evaluation or writes. */
export async function readCaseWorkflowHistory(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
) {
  const rows = await tx.query<
    NonNullable<DeskSnapshot['workflowRuns']>[number]
  >(
    `SELECT r.id,r.definition_id AS "definitionId",COALESCE(v.document->'definition'->>'name',r.definition_id) AS name,r.version,
      COALESCE((SELECT jsonb_agg(s.document ORDER BY s.sequence) FROM
       (SELECT document,sequence FROM workflow_process_steps WHERE tenant_id=r.tenant_id AND run_id=r.id ORDER BY sequence LIMIT 101) s),'[]') AS steps,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('action',a.document->'action',
       'approval',(SELECT document FROM policy_approvals WHERE tenant_id=a.tenant_id AND proposal_id=a.proposal_id
        AND action_hash=a.document->>'actionHash' ORDER BY created_at DESC,id DESC LIMIT 1),
       'execution',(SELECT document FROM executed_actions WHERE tenant_id=a.tenant_id AND proposal_id=a.proposal_id
        AND action_hash=a.document->>'actionHash' ORDER BY created_at DESC,id DESC LIMIT 1)))
       FROM (SELECT * FROM action_admission_steps a WHERE a.tenant_id=r.tenant_id AND a.proposal_id IN (
        SELECT (s.document->'values'->>'proposalId')::uuid FROM workflow_process_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id
         AND s.document->>'kind'='capability' AND s.document->'values'->>'proposalId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
         ORDER BY a.proposal_id LIMIT 101) a),'[]') AS actions
     FROM workflow_trigger_runs r LEFT JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
     WHERE r.tenant_id=$1 AND r.id IN (${caseWorkflowRuns}) ORDER BY COALESCE(r.triggered_at,r.due_at) DESC NULLS LAST,r.id LIMIT 11`,
    [tenantId, id],
  );

  return {
    workflowRunsTruncated: rows.rows.length > 10,
    workflowRuns: rows.rows.slice(0, 10).map((run) => ({
      ...run,
      steps: run.steps.slice(0, 100),
      actions: run.actions.slice(0, 100),
      truncated: run.steps.length > 100 || run.actions.length > 100,
    })),
  };
}
