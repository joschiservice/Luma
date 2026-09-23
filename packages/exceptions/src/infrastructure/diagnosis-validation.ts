import { diagnosisSchema } from '@luma/api-contract';

import type { Diagnosis } from '../domain/diagnosis.js';

/** Validates a diagnosis against the public response schema and rejects malformed documents. */
export const parseDiagnosis = (value: Diagnosis): Diagnosis =>
  diagnosisSchema.parse(value);
