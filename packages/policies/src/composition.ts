import { randomUUID } from 'node:crypto';

import type { TenantDatabase } from '@luma/platform';

import type { PolicyDependencies } from './application/policies.js';
import { createPolicyService } from './application/policies.js';
import { createPolicyRepository } from './infrastructure/repository.js';

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
