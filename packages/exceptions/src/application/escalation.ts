import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';

/**
 * Creates a tenant-scoped command for requesting manual attention at a specific incident
 * revision.
 */
export function createEscalationService(
  commit: (
    context: TenantContext,
    id: string,
    revision: number,
  ) => Promise<number>,
) {
  return (context: TenantContext, id: string, revision: number) => {
    requirePermission(context, 'issues.manage');

    return commit(context, id, revision);
  };
}
