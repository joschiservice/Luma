import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
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

const authoring = '/v1/organizations/{organizationId}/workflow-authoring';
const drafts = '/v1/organizations/{organizationId}/workflow-drafts/{draftId}';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});
const proposalParams = draftParams.extend({ proposalId: z.string().uuid() });

export const workflowGenerationContract = {
  availability: endpoint
    .route({
      method: 'GET',
      path: `${authoring}/generation`,
      summary: 'Check whether workflows can be described here',
      description:
        'Requires `workflows.read`. Describing workflows needs an EU model route with zero data retention. When none is configured, `reason` explains what an administrator must set up.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(generationAvailabilitySchema),
  describe: endpoint
    .route({
      method: 'POST',
      path: `${authoring}/describe`,
      summary: 'Start a draft from a description',
      description:
        'Requires `workflows.author`. Describe what should happen and get a new draft with an explanation of each step, the assumptions made and open questions. Each question names the step and field to fill in. The draft uses only what this workspace has installed and still needs review, testing and publishing: generation never publishes, activates, approves or starts a workflow. The model may be asked up to three times; remaining problems are returned as diagnostics. If the model fails, times out or returns nothing usable, the request returns 503, no draft is created, and you can try again. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: describeWorkflowSchema,
      }),
    )
    .output(generatedDraftSchema),
  refine: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/proposals`,
      summary: 'Propose a change from an instruction',
      description:
        'Requires `workflows.author`. Describe a change to the revision you loaded. The response is a proposal with step-level changes; the draft is unchanged until the proposal is accepted. Returns 409 if the draft changed since you loaded it, and 503 with nothing changed if the model fails or times out. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: refineWorkflowDraftSchema }))
    .output(draftProposalSchema),
  accept: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/proposals/{proposalId}/accept`,
      summary: 'Apply a proposed change',
      description:
        'Requires `workflows.author`. Saves the proposed content as a new draft revision. If the draft changed after the proposal was made, the request returns 409 and nothing is applied. Accepting never publishes. Reuse the same save ID after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: proposalParams, body: acceptProposalSchema }))
    .output(acceptedProposalSchema),
  reject: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/proposals/{proposalId}/reject`,
      summary: 'Reject a proposed change',
      description:
        'Requires `workflows.author`. Discards a proposal. The draft is unchanged. Rejecting again is safe.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: proposalParams, body: z.object({}).strict() }))
    .output(z.object({ proposal: draftProposalSchema })),
  codeStep: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/code-step-suggestions`,
      summary: 'Suggest a Code Step from a description',
      description:
        'Requires `workflows.author`. Describe a calculation and get TypeScript source, returned fields, grants and example cases for the Code Step editor. The source uses only values available at that step and requests only the reads and actions directly after it. Nothing is saved. Returns 503 with nothing changed if the model fails or times out. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({ params: draftParams, body: codeStepSuggestionRequestSchema }),
    )
    .output(codeStepSuggestionSchema),
  generations: endpoint
    .route({
      method: 'GET',
      path: `${drafts}/generations`,
      summary: 'List how a draft was generated',
      description:
        'Requires `workflows.read`. People can read the model route, token usage, attempts and outcome of each request for this draft, newest first. Prompts are stored only as a hash. These records show authorship; they don’t approve anything.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams }))
    .output(z.object({ items: z.array(workflowGenerationSchema) })),
};
