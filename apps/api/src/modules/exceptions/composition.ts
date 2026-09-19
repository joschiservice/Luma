import { createDiagnosisService } from '#modules/exceptions/application/diagnosis';
import type { DiagnosisOptions } from '#modules/exceptions/application/diagnosis';
import { createDiagnosisRepository } from '#modules/exceptions/infrastructure/diagnosis-repository';
import {
  boundedInvestigation,
  selectionSchema,
  diagnosisTrace,
} from '#modules/exceptions/infrastructure/diagnosis-boundary';
import { parseDiagnosis } from '#modules/exceptions/api/diagnosis';
import { detectionBoundary } from '#modules/exceptions/infrastructure/validation';
import type { TenantDatabase } from '#modules/platform/index';
import type { VerificationEvaluator } from '#modules/exceptions/application/detection';
import { createDetectionService } from '#modules/exceptions/application/detection';
import { createDetectionRepository } from '#modules/exceptions/infrastructure/repository';
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

import { createCaseService } from '#modules/exceptions/application/cases';
import { createCaseReader } from '#modules/exceptions/infrastructure/cases';
export function createCases(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
) {
  return createCaseService(createCaseReader(db, now));
}
export { caseRoutes } from '#modules/exceptions/api/cases';

import { createEscalationService } from '#modules/exceptions/application/escalation';
import { createEscalationRepository } from '#modules/exceptions/infrastructure/escalation';
export function createCaseEscalation(db: TenantDatabase) {
  return createEscalationService(createEscalationRepository(db));
}
