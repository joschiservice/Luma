import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  acceptedProposalSchema,
  acceptProposalSchema,
  codeStepSuggestionRequestSchema,
  codeStepSuggestionSchema,
  describeWorkflowSchema,
  draftProposalSchema,
  generatedDraftSchema,
  generationAvailabilitySchema,
  refineWorkflowDraftSchema,
  workflowGenerationSchema,
} from '../workflow-generation.js';

const c = initContract();
const authoring = '/v1/organizations/:organizationId/workflow-authoring';
const drafts = '/v1/organizations/:organizationId/workflow-drafts/:draftId';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});
const proposalParams = draftParams.extend({ proposalId: z.string().uuid() });

export const workflowGenerationContract = c.router(
  {
    availability: {
      method: 'GET',
      path: `${authoring}/generation`,
      pathParams: organizationParamsSchema,
      responses: { 200: generationAvailabilitySchema },
      summary: 'Check whether workflows can be described here',
      description:
        'Members can check this. Describing workflows needs an EU model route with zero data retention. When none is configured, `reason` explains what an administrator must set up.',
    },
    describe: {
      method: 'POST',
      path: `${authoring}/describe`,
      pathParams: organizationParamsSchema,
      body: describeWorkflowSchema,
      responses: { 200: generatedDraftSchema },
      summary: 'Start a draft from a description',
      description:
        'Owners and admins describe what should happen and get a new draft with an explanation of each step, the assumptions made and open questions. Each question names the step and field to fill in. The draft uses only what this workspace has installed and still needs review, testing and publishing: generation never publishes, activates, approves or starts a workflow. The model may be asked up to three times; remaining problems are returned as diagnostics. If the model fails, times out or returns nothing usable, the request returns 503, no draft is created, and you can try again. Reuse the same ID and body after an uncertain response.',
    },
    refine: {
      method: 'POST',
      path: `${drafts}/proposals`,
      pathParams: draftParams,
      body: refineWorkflowDraftSchema,
      responses: { 200: draftProposalSchema },
      summary: 'Propose a change from an instruction',
      description:
        'Owners and admins describe a change to the revision they loaded. The response is a proposal with step-level changes; the draft is unchanged until the proposal is accepted. Returns 409 if the draft changed since you loaded it, and 503 with nothing changed if the model fails or times out. Reuse the same ID and body after an uncertain response.',
    },
    accept: {
      method: 'POST',
      path: `${drafts}/proposals/:proposalId/accept`,
      pathParams: proposalParams,
      body: acceptProposalSchema,
      responses: { 200: acceptedProposalSchema },
      summary: 'Apply a proposed change',
      description:
        'Owners and admins save the proposed content as a new draft revision. If the draft changed after the proposal was made, the request returns 409 and nothing is applied. Accepting never publishes. Reuse the same save ID after an uncertain response.',
    },
    reject: {
      method: 'POST',
      path: `${drafts}/proposals/:proposalId/reject`,
      pathParams: proposalParams,
      body: z.object({}).strict(),
      responses: { 200: z.object({ proposal: draftProposalSchema }) },
      summary: 'Reject a proposed change',
      description:
        'Owners and admins discard a proposal. The draft is unchanged. Rejecting again is safe.',
    },
    codeStep: {
      method: 'POST',
      path: `${drafts}/code-step-suggestions`,
      pathParams: draftParams,
      body: codeStepSuggestionRequestSchema,
      responses: { 200: codeStepSuggestionSchema },
      summary: 'Suggest a Code Step from a description',
      description:
        'Owners and admins describe a calculation and get TypeScript source, returned fields, grants and example cases for the Code Step editor. The source uses only values available at that step and requests only the reads and actions directly after it. Nothing is saved. Returns 503 with nothing changed if the model fails or times out. Reuse the same ID and body after an uncertain response.',
    },
    generations: {
      method: 'GET',
      path: `${drafts}/generations`,
      pathParams: draftParams,
      responses: {
        200: z.object({ items: z.array(workflowGenerationSchema) }),
      },
      summary: 'List how a draft was generated',
      description:
        'Members can read the model route, token usage, attempts and outcome of each request for this draft, newest first. Prompts are stored only as a hash. These records show authorship; they don’t approve anything.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
