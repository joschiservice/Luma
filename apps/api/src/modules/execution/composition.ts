import { randomUUID } from 'node:crypto';
import type { TenantDatabase } from '#modules/platform/index';
import type { AuditLog } from '#modules/audit/index';
import type { PolicyService } from '#modules/policies/index';
import type { EffectRegistry } from '#modules/connectors/index';
import type { ExecutionDependencies } from '#modules/execution/application/execution';
import { createExecutionService } from '#modules/execution/application/execution';
import { createExecutionRepository } from '#modules/execution/infrastructure/repository';
import {
  parseAction,
  parseEvidence,
  parseVerification,
} from '#modules/execution/infrastructure/validation';
export function createExecution(
  db: TenantDatabase,
  policies: PolicyService,
  audit: AuditLog,
  registry: EffectRegistry,
  refreshContext: ExecutionDependencies['refreshContext'],
) {
  return createExecutionService({
    repository: createExecutionRepository(db),
    policies,
    audit,
    registry,
    refreshContext,
    parse: parseAction,
    parseVerification,
    parseEvidence,
    now: () => new Date(),
    id: randomUUID,
  });
}

export { parseAction } from '#modules/execution/infrastructure/validation';
