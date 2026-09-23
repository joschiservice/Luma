export { currentPolicyVersion } from './domain/action.js';

export type {
  Approval,
  PolicyDecision,
  PolicyEvidence,
  ProposedAction,
  Provenance,
} from './domain/action.js';

export type {
  PolicyDependencies,
  PolicyRepository,
  PolicyService,
} from './application/policies.js';

export { evaluatePolicy } from './domain/evaluate.js';
