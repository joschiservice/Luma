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

export type { ScopedAutonomy } from './application/scoped-autonomy.js';

/** @public Names the scope admission reason in the inferred safety service declaration. */
export type { AutonomyBlock } from './domain/scoped-autonomy.js';

export type {
  AutonomyAdmission,
  ScopedResponsibilityFacts,
} from './domain/scoped-autonomy.js';
