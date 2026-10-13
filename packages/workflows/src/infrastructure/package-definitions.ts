import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requireChangesAllowed,
  requirePermission,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

/** Archives package-owned workflow definitions without erasing immutable versions or run evidence. */
export function createPackageWorkflowArchive(db: TenantDatabase) {
  return {
    async archive(
      context: TenantContext,
      packageId: string,
      definitionId: string,
    ) {
      requireChangesAllowed(context);
      requirePermission(context, 'workflows.publish');
      await db.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `workflow-definition:${context.tenantId}:${definitionId}`,
        ]);
        const versions = await tx.query<{ document: Record<string, unknown> }>(
          'SELECT document FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2',
          [context.tenantId, definitionId],
        );
        if (
          !versions.rows.length ||
          versions.rows.some((row) => {
            const p = row.document.provenance;

            return (
              !p ||
              typeof p !== 'object' ||
              !('reference' in p) ||
              typeof p.reference !== 'string' ||
              !p.reference.startsWith(`package:${packageId}:`)
            );
          })
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'This workflow has a version owned outside the package.',
          );
        const active = await tx.query(
          `SELECT 1 FROM workflow_subscription_heads h JOIN workflow_subscription_revisions r ON r.tenant_id=h.tenant_id AND r.id=h.id AND r.revision=h.revision WHERE h.tenant_id=$1 AND r.definition_id=$2 AND COALESCE((r.document->>'enabled')::boolean,false) LIMIT 1`,
          [context.tenantId, definitionId],
        );
        const pending = await tx.query(
          "SELECT 1 FROM workflow_trigger_runs r LEFT JOIN LATERAL(SELECT document FROM workflow_process_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id ORDER BY sequence DESC LIMIT 1) last ON true WHERE r.tenant_id=$1 AND r.definition_id=$2 AND r.state IN ('scheduled','awaiting_admission') AND (last.document IS NULL OR last.document->>'kind'<>'end') LIMIT 1",
          [context.tenantId, definitionId],
        );
        if (active.rowCount || pending.rowCount)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Disable workflow triggers and finish or cancel its runs before removing this package.',
          );
        await tx.query(
          'INSERT INTO workflow_package_archives(tenant_id,definition_id,package_id,archived_by,archived) VALUES($1,$2,$3,$4,true) ON CONFLICT(tenant_id,definition_id) DO UPDATE SET archived=true,archived_by=EXCLUDED.archived_by,changed_at=clock_timestamp()',
          [context.tenantId, definitionId, packageId, context.actor.id],
        );
      });
    },
    async restore(
      context: TenantContext,
      packageId: string,
      definitionId: string,
    ) {
      requireChangesAllowed(context);
      requirePermission(context, 'workflows.publish');
      await db.transaction(context.tenantId, (tx) =>
        tx.query(
          'UPDATE workflow_package_archives SET archived=false,archived_by=$4,changed_at=clock_timestamp() WHERE tenant_id=$1 AND definition_id=$2 AND package_id=$3',
          [context.tenantId, definitionId, packageId, context.actor.id],
        ),
      );
    },
  };
}
