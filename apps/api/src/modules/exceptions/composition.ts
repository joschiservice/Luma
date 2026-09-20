import { parseDiagnosis } from '#modules/exceptions/api/diagnosis';
import { createCaseService } from '#modules/exceptions/application/cases';
import type { VerificationEvaluator } from '#modules/exceptions/application/detection';
import { createDetectionService } from '#modules/exceptions/application/detection';
import type { DiagnosisOptions } from '#modules/exceptions/application/diagnosis';
import { createDiagnosisService } from '#modules/exceptions/application/diagnosis';
import { createEscalationService } from '#modules/exceptions/application/escalation';
import { createCaseReader } from '#modules/exceptions/infrastructure/cases';
import {
  boundedInvestigation,
  diagnosisTrace,
  selectionSchema,
} from '#modules/exceptions/infrastructure/diagnosis-boundary';
import { createDiagnosisRepository } from '#modules/exceptions/infrastructure/diagnosis-repository';
import { createEscalationRepository } from '#modules/exceptions/infrastructure/escalation';
import { createDetectionRepository } from '#modules/exceptions/infrastructure/repository';
import { detectionBoundary } from '#modules/exceptions/infrastructure/validation';
import type { TenantDatabase } from '#modules/platform/index';

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

export { parseInput } from '#modules/exceptions/infrastructure/validation';

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
) {
  return createCaseService(createCaseReader(db, now));
}

export { caseRoutes } from '#modules/exceptions/api/cases';

/** Creates a persistent command for escalating a tenant's incident to manual attention. */
export function createCaseEscalation(db: TenantDatabase) {
  return createEscalationService(createEscalationRepository(db));
}
