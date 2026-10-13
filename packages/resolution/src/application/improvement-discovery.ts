import {
  IdentityError,
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';

import {
  discoverImprovements,
  type ImprovementDiscoverySource,
} from '../domain/improvement-discovery.js';

/** Finds recurring verified work on an explicit request; it never invokes generation or changes a workflow. */
export function createImprovementDiscovery(deps: {
  read(
    context: TenantContext,
    asOf: string,
  ): Promise<ImprovementDiscoverySource[]>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  enabled(tenantId: string): Promise<boolean>;
  hash(value: unknown): string;
  now(): Date;
}) {
  return {
    async discover(context: TenantContext) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requirePermission(fresh, 'issues.manage');
      requirePermission(fresh, 'workflows.author');
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Your access changed.');
      if (!(await deps.enabled(fresh.tenantId)))
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Workflow improvement discovery is unavailable.',
        );
      const asOf = deps.now().toISOString();

      return {
        asOf,
        windowDays: 30,
        minimumIncidents: 3,
        items: discoverImprovements(
          await deps.read(fresh, asOf),
          asOf,
          deps.hash,
        ),
      };
    },
  };
}
