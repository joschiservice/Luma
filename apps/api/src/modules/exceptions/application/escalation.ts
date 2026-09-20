import type { TenantContext } from '#modules/identity/index';
import { requireRole } from '#modules/identity/index';

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
    requireRole(context, ['owner', 'admin']);

    return commit(context, id, revision);
  };
}
