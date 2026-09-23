import { policyAudit } from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import type { EffectRegistry } from '@luma/connections';
import { createExecution } from '@luma/execution/composition';
import type { IdentityService } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { createPolicies } from '@luma/policies/composition';
import { Pool } from 'pg';

/** Exercise engine persistence and failure recovery without provisioning a playbook. */
export function createSafetyFixture(
  databaseUrl: string,
  identity: Pick<IdentityService, 'refreshContext'>,
  registry: EffectRegistry,
) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = createTenantDatabase(pool);
  const audit = createAuditLog(db);
  const policies = createPolicies(
    db,
    identity.refreshContext,
    policyAudit(audit),
  );

  return {
    policies,
    execution: createExecution(
      db,
      policies,
      audit,
      registry,
      identity.refreshContext,
    ),
    close: () => pool.end(),
  };
}
