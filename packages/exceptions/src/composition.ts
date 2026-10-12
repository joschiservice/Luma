import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createCaseService } from './application/cases.js';
import type { VerificationEvaluator } from './application/detection.js';
import { createDetectionService } from './application/detection.js';
import type { DiagnosisOptions } from './application/diagnosis.js';
import { createDiagnosisService } from './application/diagnosis.js';
import { createEscalationService } from './application/escalation.js';
import { createCaseOwners } from './application/owners.js';
import { createCaseReader } from './infrastructure/cases.js';
import {
  boundedInvestigation,
  diagnosisTrace,
  selectionSchema,
} from './infrastructure/diagnosis-boundary.js';
import { createDiagnosisRepository } from './infrastructure/diagnosis-repository.js';
import { parseDiagnosis } from './infrastructure/diagnosis-validation.js';
import { createEscalationRepository } from './infrastructure/escalation.js';
import { createCaseOwnerStore } from './infrastructure/owners.js';
import { createDetectionRepository } from './infrastructure/repository.js';
import { detectionBoundary } from './infrastructure/validation.js';

/**
 * Creates persistent incident detection and resolution services with the standard validation
 * boundary.
 */
export function createExceptions(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
  verifier?: VerificationEvaluator,
) {
  return createDetectionService(
    createDetectionRepository(db),
    now,
    detectionBoundary,
    verifier,
  );
}

export { parseInput } from './infrastructure/validation.js';

/**
 * Creates persistent investigations with validated output and optional model reasoning or
 * connector rereads.
 */
export function createDiagnoses(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
  options: DiagnosisOptions = {},
) {
  return createDiagnosisService(
    createDiagnosisRepository(db),
    now,
    {
      id: detectionBoundary.id,
      parse: parseDiagnosis,
      selection: selectionSchema,
      trace: diagnosisTrace,
      bounded: boundedInvestigation,
    },
    options,
  );
}

/** Creates tenant-scoped case reads using persisted incidents and diagnoses. */
export function createCases(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
  productIdentities?: Parameters<typeof createCaseService>[1],
  identity?: Pick<IdentityService, 'refreshContext' | 'listMembers'>,
  audit?: Parameters<typeof createCaseOwnerStore>[1],
) {
  return createCaseService(
    createCaseReader(db, now),
    productIdentities,
    identity && audit
      ? createCaseOwners({
          store: createCaseOwnerStore(db, audit),
          refreshContext: identity.refreshContext,
          members: identity.listMembers,
        })
      : undefined,
  );
}

/** Creates a persistent command for escalating a tenant's incident to manual attention. */
export function createCaseEscalation(db: TenantDatabase) {
  return createEscalationService(createEscalationRepository(db));
}

export {
  caseDecisionQuery,
  caseTimelineQuery,
  orderAttentionQuery,
  orderAttentionForOrders,
} from './infrastructure/cases.js';

export { createOrderAttentionBoundaryReader } from './infrastructure/cases.js';

export { createCaseMetricReader } from './infrastructure/cases.js';
