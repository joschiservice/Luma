import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/**
 * Reads the id of the most recent policy decision for a proposal in the caller's tenant, or
 * null when the proposal has none. Callers compare it to detect a superseded decision.
 */
export function createLatestPolicyDecisionReader(database: TenantDatabase) {
  return (context: TenantContext, proposalId: string) =>
    database.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            'SELECT id FROM policy_decisions WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
            [context.tenantId, proposalId],
          )
        ).rows[0]?.id ?? null,
    );
}
