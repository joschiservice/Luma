export { createDetectionService } from './application/detection.js';

export type {
  DetectionRepository,
  DetectionRequest,
  DetectionResult,
  DetectionService,
  Evidence,
  Incident,
  IncidentVerificationAttempt,
  VerificationEvaluator,
  VerificationResult,
} from './application/detection.js';

export {
  decimalString,
  decimalUnits,
  defaultConfiguration,
} from './domain/facts.js';

export type {
  Configuration,
  EvaluationInput,
  ExceptionClass,
  Facts,
} from './domain/facts.js';

export { createDiagnosisService } from './application/diagnosis.js';

export type {
  DiagnosisOptions,
  DiagnosisRepository,
  DiagnosisRereader,
  DiagnosisService,
  ReasoningSelection,
} from './application/diagnosis.js';

export type { Diagnosis, DiagnosisInput } from './domain/diagnosis.js';

export type { CaseService } from './application/cases.js';

export { evaluate as evaluateException } from './domain/evaluate.js';

export { caseMetricDefinitions } from './domain/metrics.js';

export type { CaseMetricItem } from './domain/metrics.js';
