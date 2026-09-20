import { randomUUID } from 'node:crypto';

import type { TenantDatabase } from '#modules/platform/index';
import type { PolicyDependencies } from '#modules/policies/application/policies';
import { createPolicyService } from '#modules/policies/application/policies';
import { createPolicyRepository } from '#modules/policies/infrastructure/repository';

/**
 * Creates persistent policy evaluation and approvals with fresh authorization and the
 * supplied evidence writer.
 */
export function createPolicies(
  db: TenantDatabase,
  refreshContext: PolicyDependencies['refreshContext'],
  appendEvidence: PolicyDependencies['appendEvidence'],
) {
  return createPolicyService({
    repository: createPolicyRepository(db),
    refreshContext,
    appendEvidence,
    now: () => new Date(),
    id: randomUUID,
  });
}
