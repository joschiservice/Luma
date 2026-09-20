import { Pool } from 'pg';

import { policyAudit } from '#app';
import { createAuditLog } from '#modules/audit/composition';
import type { EffectRegistry } from '#modules/connectors/index';
import { createExecution } from '#modules/execution/composition';
import type { IdentityService } from '#modules/identity/index';
import { createTenantDatabase } from '#modules/platform/composition';
import { createPolicies } from '#modules/policies/composition';

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
