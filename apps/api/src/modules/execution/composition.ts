import { randomUUID } from 'node:crypto';
import type { TenantDatabase } from '../platform/index.js';
import type { AuditLog } from '../audit/index.js';
import type { PolicyService } from '../policies/index.js';
import type { EffectRegistry } from '../connectors/index.js';
import type { ExecutionDependencies } from './application/execution.js';
import { createExecutionService } from './application/execution.js';
import { createExecutionRepository } from './infrastructure/repository.js';
import {
  parseAction,
  parseEvidence,
  parseVerification,
} from './infrastructure/validation.js';
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
