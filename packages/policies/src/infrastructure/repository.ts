import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

import type { PolicyRepository } from '../application/policies.js';
import type {
  Approval,
  PolicyDecision,
  PolicyEvidence,
} from '../domain/action.js';
import { workspacePolicyVersion } from '../domain/action.js';

/**
 * Creates tenant-scoped storage for policy decisions and approvals with idempotency and
 * version checks.
 */
export function createPolicyRepository(db: TenantDatabase): PolicyRepository {
  return {
    workspacePolicy: (tenantId) =>
      db.transaction(tenantId, async (tx) => {
        return readWorkspacePolicy(tx, tenantId);
      }),
    pending: (tenantId) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: PolicyEvidence }>(
          'SELECT document FROM policy_outbox WHERE tenant_id=$1 AND delivered_at IS NULL ORDER BY created_at,id',
          [tenantId],
        );

        return result.rows.map((row) => row.document);
      }),
    delivered: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          'UPDATE policy_outbox SET delivered_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
      }),
    saveDecision: (decision) =>
      db.transaction(decision.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO policy_decisions(id, tenant_id, proposal_id, action_hash, document) VALUES ($1,$2,$3,$4,$5)',
          [
            decision.id,
            decision.tenantId,
            decision.proposalId,
            decision.actionHash,
            decision,
          ],
        );
        await tx.query(
          'INSERT INTO policy_outbox(id,tenant_id,document) VALUES ($1,$2,$3)',
          [
            decision.id,
            decision.tenantId,
            { type: 'policy.evaluated', document: decision },
          ],
        );
      }),
    findDecision: (tenantId, id) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: PolicyDecision }>(
          'SELECT document FROM policy_decisions WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );

        return result.rows[0]?.document ?? null;
      }),
    findDecisions: (tenantId, ids) =>
      db.transaction(tenantId, async (tx) => {
        // Each decision's approval follows the same rule as `findApproval`.
        const result = await tx.query<{
          decision: PolicyDecision;
          approval: Approval | null;
        }>(
          `SELECT d.document AS decision,a.document AS approval FROM policy_decisions d
           LEFT JOIN LATERAL (SELECT p.document FROM policy_approvals p WHERE p.tenant_id=d.tenant_id
            AND p.proposal_id=d.proposal_id AND p.action_hash=d.action_hash
            AND (p.policy_version=d.document->>'policyVersion' OR p.document->>'outcome'='rejected')
            ORDER BY (p.document->>'outcome'='rejected') DESC,p.created_at DESC LIMIT 1) a ON true
           WHERE d.tenant_id=$1 AND d.id=ANY($2::uuid[])`,
          [tenantId, ids],
        );

        return result.rows;
      }),
    findApproval: (tenantId, proposalId, hash, version) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: Approval }>(
          "SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=$2 AND action_hash=$3 AND (policy_version=$4 OR document->>'outcome'='rejected') ORDER BY (document->>'outcome'='rejected') DESC,created_at DESC LIMIT 1",
          [tenantId, proposalId, hash, version],
        );

        return result.rows[0]?.document ?? null;
      }),
    saveApproval: (approval) =>
      db.transaction(approval.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `exceptions:${approval.tenantId}`,
        ]);
        const current = await readWorkspacePolicy(tx, approval.tenantId);
        if (
          workspacePolicyVersion(
            current.revision,
            current.requireIndependentApproval,
            current.autonomyRevision,
          ) !== approval.policyVersion
        )
          throw conflict('Approval policy changed. Refresh the review.');
        await tx.query(
          'INSERT INTO policy_approvals(id, tenant_id, proposal_id, action_hash, policy_version, document) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, proposal_id, action_hash, policy_version) DO NOTHING',
          [
            approval.id,
            approval.tenantId,
            approval.proposalId,
            approval.actionHash,
            approval.policyVersion,
            approval,
          ],
        );
        const result = await tx.query<{ document: Approval }>(
          'SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=$2 AND action_hash=$3 AND policy_version=$4',
          [
            approval.tenantId,
            approval.proposalId,
            approval.actionHash,
            approval.policyVersion,
          ],
        );
        const saved = result.rows[0]!.document;
        await tx.query(
          'INSERT INTO policy_outbox(id,tenant_id,document) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,id) DO NOTHING',
          [
            saved.id,
            saved.tenantId,
            { type: 'approval.responded', document: saved },
          ],
        );

        await tx.query(
          "UPDATE autonomy_history SET document=jsonb_set(document,'{review}',to_jsonb($3::text)),updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2 AND document->>'review'='not_reviewed'",
          [
            saved.tenantId,
            saved.proposalId,
            saved.outcome === 'approved' ? 'accepted' : 'overridden',
          ],
        );

        return saved;
      }),
  };
}

/** Reads the preference and membership exception in the same database snapshot. */
async function readWorkspacePolicy(tx: SqlTransaction, tenantId: string) {
  const result = await tx.query<{
    revision: number;
    autonomyRevision: number;
    required: boolean;
    requireIndependentApproval: boolean;
  }>(
    `SELECT COALESCE(a.revision,0) AS "autonomyRevision",COALESCE(s.policy_revision,0) AS revision,COALESCE(s.always_require_approval,false) AS required,
    workspace_requires_independent_approval() AS "requireIndependentApproval"
    FROM (SELECT $1::uuid AS tenant_id) t LEFT JOIN workspace_settings s ON s.tenant_id=t.tenant_id LEFT JOIN autonomy_epochs a ON a.tenant_id=t.tenant_id`,
    [tenantId],
  );

  return result.rows[0]!;
}
