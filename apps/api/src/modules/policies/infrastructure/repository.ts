import type { TenantDatabase } from '#modules/platform/index';
import type { PolicyRepository } from '#modules/policies/application/policies';
import type {
  Approval,
  PolicyDecision,
  PolicyEvidence,
} from '#modules/policies/domain/action';
export function createPolicyRepository(db: TenantDatabase): PolicyRepository {
  return {
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
    findApproval: (tenantId, proposalId, hash, version) =>
      db.transaction(tenantId, async (tx) => {
        const result = await tx.query<{ document: Approval }>(
          'SELECT document FROM policy_approvals WHERE tenant_id=$1 AND proposal_id=$2 AND action_hash=$3 AND policy_version=$4',
          [tenantId, proposalId, hash, version],
        );
        return result.rows[0]?.document ?? null;
      }),
    saveApproval: (approval) =>
      db.transaction(approval.tenantId, async (tx) => {
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
        return saved;
      }),
  };
}
