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
