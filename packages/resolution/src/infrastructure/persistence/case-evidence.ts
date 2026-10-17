import type { SqlTransaction } from '@luma/platform';

import { caseWorkflowProposals } from './case-workflow-history.js';

/** A case record that a reference names, in the shape the evidence view reads. */
interface CaseRecord {
  kind: 'luma_record';
  id: string;
  record: 'case' | 'case_proposal' | 'policy_decision' | 'approval';
}

/** The case's own proposals and those of the workflow runs started for it. */
const caseActions = `SELECT id FROM case_proposals WHERE tenant_id=$1 AND exception_id=$2::uuid
 UNION ${caseWorkflowProposals}`;

/**
 * Reads what a case cites, for the evidence view: the actions whose execution attempts belong
 * to the case, from its own proposals and its workflow runs. Returns null when the tenant has no
 * such case.
 */
export async function caseCitations(
  tx: SqlTransaction,
  tenantId: string,
  caseId: string,
): Promise<{ actionIds: string[]; citations: [] } | null> {
  const found = await tx.query(
    'SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id=$2',
    [tenantId, caseId],
  );
  if (!found.rowCount) return null;
  const actions = await tx.query<{ id: string }>(
    `SELECT id::text FROM (${caseActions}) a LIMIT 200`,
    [tenantId, caseId],
  );

  return { actionIds: actions.rows.map((row) => row.id), citations: [] };
}

/**
 * Finds the case, its proposals and their policy decisions and approvals among the references.
 * Provider evidence of the case's writes belongs to the apps that made them.
 */
export async function caseRecords(
  tx: SqlTransaction,
  tenantId: string,
  caseId: string,
  refs: { uuids: string[] },
): Promise<CaseRecord[]> {
  if (!refs.uuids.length) return [];
  const { rows } = await tx.query<{ id: string; record: CaseRecord['record'] }>(
    `WITH actions AS (${caseActions})
     SELECT id::text,'case' AS record FROM exceptions
      WHERE tenant_id=$1 AND id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'case_proposal' FROM case_proposals
      WHERE tenant_id=$1 AND exception_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'policy_decision' FROM policy_decisions
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND proposal_id IN (SELECT id FROM actions)
     UNION ALL SELECT id::text,'approval' FROM policy_approvals
      WHERE tenant_id=$1 AND id=ANY($3::uuid[]) AND proposal_id IN (SELECT id FROM actions)`,
    [tenantId, caseId, refs.uuids],
  );

  return rows.map((row) => ({ kind: 'luma_record', ...row }));
}
