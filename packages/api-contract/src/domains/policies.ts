import { scopedAutonomyContract } from '../contracts/scoped-autonomy.js';

/** Routes served by `@luma/policies`. */
type PoliciesContracts = {
  scopedAutonomy: typeof scopedAutonomyContract;
};

/** Routes served by `@luma/policies`, keyed by area. */
export const policiesContracts: PoliciesContracts = {
  scopedAutonomy: scopedAutonomyContract,
};
