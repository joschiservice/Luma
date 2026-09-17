import { detectionBoundary } from './infrastructure/validation.js';
import type { TenantDatabase } from '../platform/index.js';
import { createDetectionService } from './application/detection.js';
import { createDetectionRepository } from './infrastructure/repository.js';
export function createExceptions(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
) {
  return createDetectionService(
    createDetectionRepository(db),
    now,
    detectionBoundary,
  );
}

export { parseInput } from './infrastructure/validation.js';
