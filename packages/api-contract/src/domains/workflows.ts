import { draftTestsContract } from '../contracts/draft-tests.js';
import { workflowDraftsContract } from '../contracts/workflow-drafts.js';
import { workflowGenerationContract } from '../contracts/workflow-generation.js';
import { workflowsContract } from '../contracts/workflows.js';

/** Routes served by `@luma/workflows`. */
type WorkflowsContracts = {
  draftTests: typeof draftTestsContract;
  workflowDrafts: typeof workflowDraftsContract;
  workflowGeneration: typeof workflowGenerationContract;
  workflows: typeof workflowsContract;
};

/** Routes served by `@luma/workflows`, keyed by area. */
export const workflowsContracts: WorkflowsContracts = {
  draftTests: draftTestsContract,
  workflowDrafts: workflowDraftsContract,
  workflowGeneration: workflowGenerationContract,
  workflows: workflowsContract,
};
