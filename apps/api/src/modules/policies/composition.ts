import { randomUUID } from 'node:crypto';
import type { TenantDatabase } from '../platform/index.js';
import { createPolicyService } from './application/policies.js';
import type { PolicyDependencies } from './application/policies.js';
import { createPolicyRepository } from './infrastructure/repository.js';
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
