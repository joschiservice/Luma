/** @public Declaration emit names it in the inferred types of the detection pipeline and inventory monitor in resolution. */
export type { DetectionResult } from './application/detection.js';

export type {
  DetectionRequest,
  DetectionService,
  Evidence,
  Incident,
  IncidentVerificationAttempt,
  VerificationEvaluator,
  VerificationResult,
} from './application/detection.js';

export { verificationPostconditions } from './application/detection.js';

export {
  decimalString,
  decimalUnits,
  defaultConfiguration,
  stallSuspected,
  stallThresholds,
} from './domain/facts.js';

export type { Configuration, Facts } from './domain/facts.js';

export { workspaceDetectionConfiguration } from './domain/workspace-configuration.js';

export type {
  DiagnosisOptions,
  DiagnosisRereader,
  DiagnosisService,
} from './application/diagnosis.js';

export type { Diagnosis, DiagnosisInput } from './domain/diagnosis.js';

export type { CaseService } from './application/cases.js';

export { evaluate as evaluateException } from './domain/evaluate.js';

export { caseMetricDefinitions } from './domain/metrics.js';

export { exceptionClassLabel } from './domain/labels.js';

export type { CaseMetricItem } from './domain/metrics.js';
