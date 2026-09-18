import { diagnosisSchema } from '@luma/api-contract';
import type { Diagnosis } from '#modules/exceptions/domain/diagnosis';
export const parseDiagnosis = (value: Diagnosis): Diagnosis =>
  diagnosisSchema.parse(value);
