import { randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { EffectRegistry } from '@luma/connections';
import type { TenantDatabase } from '@luma/platform';
import type { PolicyService } from '@luma/policies';

import type { AdmissionDependencies } from './application/admission.js';
import { createActionAdmission } from './application/admission.js';
import type { ExecutionDependencies } from './application/execution.js';
import { createExecutionService } from './application/execution.js';
import { parseAdmissionReference } from './infrastructure/admission.js';
import { createExecutionRepository } from './infrastructure/repository.js';
import {
  parseAction,
  parseEvidence,
  parseVerification,
} from './infrastructure/validation.js';
import { createWriteControl } from './infrastructure/write-control.js';

/**
 * Creates persistent action execution with policy, audit, capability, and authorization
 * boundaries.
 */
export function createExecution(
  db: TenantDatabase,
  policies: PolicyService,
  audit: AuditLog,
  registry: EffectRegistry,
  refreshContext: ExecutionDependencies['refreshContext'],
) {
  return createExecutionService({
    writeControl: createWriteControl(db),
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

export { parseAction } from './infrastructure/validation.js';

export { createAdmissionStore } from './infrastructure/admission.js';

/**
 * Creates action admission with validated references and actions, using the supplied
 * eligibility and execution services.
 */
export function createAdmission(
  deps: Omit<AdmissionDependencies, 'parseAction' | 'parseReference' | 'now'>,
) {
  return createActionAdmission({
    ...deps,
    parseAction,
    parseReference: parseAdmissionReference,
    now: () => new Date(),
  });
}

export { createExecutionService, createActionAdmission };

export { parseEvidence, parseVerification };

export { parseAdmissionReference };
