import { diagnosisSchema } from '@luma/api-contract';
import type { Diagnosis } from '../domain/diagnosis.js';
export const parseDiagnosis = (value: Diagnosis): Diagnosis =>
  diagnosisSchema.parse(value);
