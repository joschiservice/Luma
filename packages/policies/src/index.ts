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

export type { PolicyService } from './application/policies.js';

export { evaluatePolicy } from './domain/evaluate.js';

/** @public Declaration emit names it in the inferred type of `createSafetyServices` in application-runtime. */
export type { PolicyCapability } from './domain/evaluate.js';
