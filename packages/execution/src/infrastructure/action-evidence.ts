import type { SqlTransaction } from '@luma/platform';

/** A reference an admitted action cites, and when the action was admitted. */
interface ActionCitation {
  ref: string;
  citedAs: 'read' | 'record';
  citedAt: string;
}

/**
 * Reads what an admitted action cites, for the evidence view of a decision about it: the
 * capability it uses (its area decides who may read the evidence), its own execution, and the
 * reads its preconditions rest on. Covers actions admitted through a workflow step and actions a
 * case published. Returns null when the tenant has no such proposal.
 */
export async function admittedActionCitations(
  tx: SqlTransaction,
  tenantId: string,
  proposalId: string,
): Promise<{
  capability: string;
  actionIds: string[];
  citations: ActionCitation[];
} | null> {
  const row = (
    await tx.query<{ action: unknown; created_at: Date }>(
      `SELECT document->'action' AS action,created_at FROM action_admission_steps
        WHERE tenant_id=$1 AND proposal_id=$2::uuid
       UNION ALL SELECT document,created_at FROM case_proposals
        WHERE tenant_id=$1 AND id=$2::uuid
       LIMIT 1`,
      [tenantId, proposalId],
    )
  ).rows[0];
  if (!row || !row.action || typeof row.action !== 'object') return null;
  const action = row.action as {
    capability?: unknown;
    preconditions?: { evidenceRefs?: unknown };
  };
  const citedAt = row.created_at.toISOString();
  const refs = Array.isArray(action.preconditions?.evidenceRefs)
    ? action.preconditions.evidenceRefs.filter(
        (ref): ref is string => typeof ref === 'string',
      )
    : [];

  return {
    capability: typeof action.capability === 'string' ? action.capability : '',
    actionIds: [proposalId],
    citations: [
      { ref: proposalId, citedAs: 'record', citedAt },
      ...[...new Set(refs)]
        .slice(0, 100)
        .map((ref) => ({ ref, citedAs: 'read' as const, citedAt })),
    ],
  };
}

/** Finds the proposal and its policy decisions and approvals among the references. */
export async function admittedActionRecords(
  tx: SqlTransaction,
  tenantId: string,
  proposalId: string,
  uuids: string[],
): Promise<
  {
    kind: 'luma_record';
    id: string;
    record: 'case_proposal' | 'policy_decision' | 'approval';
  }[]
> {
  if (!uuids.length) return [];
  const { rows } = await tx.query<{
    id: string;
    record: 'case_proposal' | 'policy_decision' | 'approval';
  }>(
    `SELECT proposal_id::text AS id,'case_proposal' AS record FROM action_admission_steps
      WHERE tenant_id=$1 AND proposal_id=$2::uuid AND proposal_id=ANY($3::uuid[])
     UNION SELECT id::text,'case_proposal' FROM case_proposals
      WHERE tenant_id=$1 AND id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'policy_decision' FROM policy_decisions
      WHERE tenant_id=$1 AND proposal_id=$2::uuid AND id=ANY($3::uuid[])
     UNION ALL SELECT id::text,'approval' FROM policy_approvals
      WHERE tenant_id=$1 AND proposal_id=$2::uuid AND id=ANY($3::uuid[])`,
    [tenantId, proposalId, uuids],
  );

  return rows.map((row) => ({
    kind: 'luma_record',
    id: row.id,
    record: row.record,
  }));
}
