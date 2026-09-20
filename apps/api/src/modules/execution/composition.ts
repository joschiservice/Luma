import { randomUUID } from 'node:crypto';

import type { AuditLog } from '#modules/audit/index';
import type { EffectRegistry } from '#modules/connectors/index';
import type { AdmissionDependencies } from '#modules/execution/application/admission';
import { createActionAdmission } from '#modules/execution/application/admission';
import type { ExecutionDependencies } from '#modules/execution/application/execution';
import { createExecutionService } from '#modules/execution/application/execution';
import { parseAdmissionReference } from '#modules/execution/infrastructure/admission';
import { createExecutionRepository } from '#modules/execution/infrastructure/repository';
import {
  parseAction,
  parseEvidence,
  parseVerification,
} from '#modules/execution/infrastructure/validation';
import type { TenantDatabase } from '#modules/platform/index';
import type { PolicyService } from '#modules/policies/index';

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

export { createAdmissionStore } from '#modules/execution/infrastructure/admission';

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

/** Give interpreted logic only this bound, reference-only function. Do not pass the service or provisioning store. */
export function bindActionAdmission(
  admission: import('#modules/execution/application/admission').ActionAdmission,
  context: import('#modules/identity/index').TenantContext,
  runId: string,
) {
  return Object.freeze({
    execute: (stepId: string) => admission.execute(context, { runId, stepId }),
  });
}
