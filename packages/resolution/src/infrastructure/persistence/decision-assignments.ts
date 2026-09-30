import type { TenantDatabase } from '@luma/platform';

import type {
  DecisionAssignment,
  DecisionAssignmentStore,
} from '../../application/decision-assignments.js';

type Row = {
  assignee_id: string | null;
  assigned_by: string;
  assigned_at: Date;
  revision: number;
};

const present = (row: Row): DecisionAssignment => ({
  assigneeId: row.assignee_id,
  assignedBy: row.assigned_by,
  assignedAt: row.assigned_at.toISOString(),
  revision: row.revision,
});

/** Stores the current assignment per decision with optimistic revisions under tenant RLS. */
export function createDecisionAssignmentStore(
  db: TenantDatabase,
): DecisionAssignmentStore {
  return {
    get: (tenantId, decisionId) =>
      db.transaction(tenantId, async (tx) => {
        const row = (
          await tx.query<Row>(
            'SELECT assignee_id,assigned_by,assigned_at,revision FROM decision_assignments WHERE tenant_id=$1 AND decision_id=$2',
            [tenantId, decisionId],
          )
        ).rows[0];

        return row ? present(row) : null;
      }),
    save: (tenantId, decisionId, expected, next) =>
      db.transaction(tenantId, async (tx) => {
        const values = [
          tenantId,
          decisionId,
          next.assigneeId,
          next.assignedBy,
          next.assignedAt,
        ];
        const row =
          expected === 0
            ? (
                await tx.query<Row>(
                  `INSERT INTO decision_assignments(tenant_id,decision_id,assignee_id,assigned_by,assigned_at,revision)
                   VALUES($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING
                   RETURNING assignee_id,assigned_by,assigned_at,revision`,
                  values,
                )
              ).rows[0]
            : (
                await tx.query<Row>(
                  `UPDATE decision_assignments SET assignee_id=$3,assigned_by=$4,assigned_at=$5,revision=revision+1
                   WHERE tenant_id=$1 AND decision_id=$2 AND revision=$6
                   RETURNING assignee_id,assigned_by,assigned_at,revision`,
                  [...values, expected],
                )
              ).rows[0];

        return row ? present(row) : null;
      }),
  };
}
