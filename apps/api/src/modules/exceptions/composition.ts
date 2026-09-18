import { createDiagnosisService } from './application/diagnosis.js';
import type { DiagnosisOptions } from './application/diagnosis.js';
import { createDiagnosisRepository } from './infrastructure/diagnosis-repository.js';
import {
  boundedInvestigation,
  selectionSchema,
  diagnosisTrace,
} from './infrastructure/diagnosis-boundary.js';
import { parseDiagnosis } from './api/diagnosis.js';
import { detectionBoundary } from './infrastructure/validation.js';
import type { TenantDatabase } from '../platform/index.js';
import type { VerificationEvaluator } from './application/detection.js';
import { createDetectionService } from './application/detection.js';
import { createDetectionRepository } from './infrastructure/repository.js';
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
