import { createHash, randomUUID } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';
import { canonicalJson } from '@luma/platform';

import type { PolicyDependencies } from './application/policies.js';
import { createPolicyService } from './application/policies.js';
import { createScopedAutonomy } from './application/scoped-autonomy.js';
import { createPolicyRepository } from './infrastructure/repository.js';
import { createAutonomyRepository } from './infrastructure/scoped-autonomy.js';

/**
 * Creates persistent policy evaluation and approvals with fresh authorization and the
 * supplied evidence writer.
 */
export function createPolicies(
  db: TenantDatabase,
  refreshContext: PolicyDependencies['refreshContext'],
  appendEvidence: PolicyDependencies['appendEvidence'],
  autonomy?: PolicyDependencies['autonomy'],
  coveredApproval?: PolicyDependencies['coveredApproval'],
  stockProtection?: PolicyDependencies['stockProtection'],
) {
  return createPolicyService({
    autonomy,
    coveredApproval,
    stockProtection,
    repository: createPolicyRepository(db),
    refreshContext,
    appendEvidence,
    now: () => new Date(),
    id: randomUUID,
  });
}

export { createPolicyService };

/** Creates persistent scoped delegation; flags and responsibility facts come from trusted runtime composition. */
export function createPersistentScopedAutonomy(
  db: TenantDatabase,
  options: Omit<
    Parameters<typeof createScopedAutonomy>[0],
    'repository' | 'hash' | 'now'
  >,
) {
  return createScopedAutonomy({
    ...options,
    repository: createAutonomyRepository(db),
    hash: (value) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    now: () => new Date(),
  });
}

export {
  reserveAutonomy,
  completeAutonomy,
} from './infrastructure/scoped-autonomy.js';

export { createStockProtectionConsent } from './infrastructure/stock-protection.js';

export { createStockProtectionAdmission } from './infrastructure/stock-protection.js';

export { policyAudit } from './application/policy-audit.js';

export { createLatestPolicyDecisionReader } from './infrastructure/latest-decision.js';
