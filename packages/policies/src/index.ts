export {
  currentPolicyVersion,
  workspacePolicyVersion,
} from './domain/action.js';

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

export { approvalRequirement, evaluatePolicy } from './domain/evaluate.js';

export type { PolicyAccess, PolicyCapability } from './domain/evaluate.js';
