import { requireTenant, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Conservatively treats prepared, uncertain and unverified stock-related effects on a connection as unsettled. */
export function createUnsettledStockEffectReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    connectionId: string,
  ): Promise<boolean> => {
    requireTenant(context, context.tenantId);

    return db.transaction(
      context.tenantId,
      async (tx) =>
        !!(
          await tx.query(
            `SELECT 1 FROM executed_actions e JOIN execution_intents i ON i.tenant_id=e.tenant_id AND i.id=e.proposal_id
   WHERE e.tenant_id=$1 AND i.document->>'connectionId'=$2
    AND (i.document->>'capability' LIKE 'inventory.%' OR i.document->>'capability' LIKE 'fulfillment.%' OR i.document->>'capability' LIKE 'returns.%' OR i.document->>'capability' LIKE 'refunds.%')
    AND (e.state IN ('prepared','unknown') OR (e.state='failed' AND COALESCE(e.document->'attempt'->>'dispatch','uncertain')<>'not_dispatched' AND COALESCE(e.document->'attempt'->'verification'->>'outcome','unknown')<>'passed')) LIMIT 1`,
            [context.tenantId, connectionId],
          )
        ).rowCount,
    );
  };
}

/** Reads durable failure classification; a retry still requires independent proof of non-dispatch. */
export function createExecutionFailureReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    proposalId: string,
  ): Promise<{
    code: string;
    effect: 'none' | 'unknown';
    retry: 'never' | 'after_delay' | 'reconcile';
  } | null> => {
    requireTenant(context, context.tenantId);

    return db.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{
            document: {
              code: string;
              effect: 'none' | 'unknown';
              retry: 'never' | 'after_delay' | 'reconcile';
            };
          }>(
            'SELECT document FROM execution_failures WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
            [context.tenantId, proposalId],
          )
        ).rows[0]?.document ?? null,
    );
  };
}
