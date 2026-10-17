import { activityContract } from '../contracts/activity.js';
import { caseDeskContract } from '../contracts/desk.js';
import { resolutionLearningContract } from '../contracts/learning.js';
import { operationsContract } from '../contracts/overview.js';
import { playbooksContract } from '../contracts/playbooks.js';
import { shadowContract } from '../contracts/shadow.js';

/** Routes served by `@luma/resolution`. */
type ResolutionContracts = {
  activity: typeof activityContract;
  caseDesk: typeof caseDeskContract;
  operations: typeof operationsContract;
  playbooks: typeof playbooksContract;
  resolutionLearning: typeof resolutionLearningContract;
  shadow: typeof shadowContract;
};

/** Routes served by `@luma/resolution`, keyed by area. */
export const resolutionContracts: ResolutionContracts = {
  activity: activityContract,
  caseDesk: caseDeskContract,
  operations: operationsContract,
  playbooks: playbooksContract,
  resolutionLearning: resolutionLearningContract,
  shadow: shadowContract,
};
