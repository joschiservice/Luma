import { diagnosisSchema } from '@luma/api-contract';

import type { Diagnosis } from '#modules/exceptions/domain/diagnosis';

/** Validates a diagnosis against the public response schema and rejects malformed documents. */
export const parseDiagnosis = (value: Diagnosis): Diagnosis =>
  diagnosisSchema.parse(value);
