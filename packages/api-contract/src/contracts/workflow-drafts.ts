import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  authoringVocabularySchema,
  createWorkflowDraftSchema,
  draftValidationSchema,
  publishedDraftSchema,
  publishWorkflowDraftSchema,
  saveWorkflowDraftSchema,
  validateWorkflowDraftSchema,
  workflowDraftSchema,
  workflowTemplateSchema,
} from '../workflow-drafts.js';

const c = initContract();
const drafts = '/v1/organizations/:organizationId/workflow-drafts';
const authoring = '/v1/organizations/:organizationId/workflow-authoring';
const templates = '/v1/organizations/:organizationId/workflow-templates';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});

export const workflowDraftsContract = c.router(
  {
    templates: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: templates,
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({ items: z.array(workflowTemplateSchema) }),
      },
      summary: 'List workflow templates',
      description:
        'Returns templates from installed adapters with what each needs before it can run, its readiness and its activation status here.',
    },
    installTemplate: {
      method: 'POST',
      metadata: requires('workflows.publish'),
      path: `${templates}/:templateId/install`,
      pathParams: organizationParamsSchema.extend({
        templateId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
      }),
      body: z.object({}).strict(),
      responses: { 200: workflowTemplateSchema },
      summary: 'Add a template to this workspace',
      description:
        'Requires `workflows.publish`. Publishes the template’s reviewed version here so it can be configured. Repeating the request is safe. Adding a template never activates it.',
    },
    vocabulary: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${authoring}/vocabulary`,
      pathParams: organizationParamsSchema,
      responses: { 200: authoringVocabularySchema },
      summary: 'List what workflows can use in this workspace',
      description:
        'Returns triggers, step types, subjects, data sources, actions and result checks from installed adapters. Entries that cannot run here are included with the reason.',
    },
    validate: {
      method: 'POST',
      metadata: requires('workflows.read'),
      path: `${authoring}/validate`,
      pathParams: organizationParamsSchema,
      body: validateWorkflowDraftSchema,
      responses: { 200: draftValidationSchema },
      summary: 'Check a draft without saving it',
      description:
        'Checks a saved draft or supplied content. Diagnostics name the step and field to fix. Errors block publishing; warnings describe what cannot run in this workspace yet. Validation changes nothing.',
    },
    list: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: drafts,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(workflowDraftSchema) }) },
      summary: 'List open workflow drafts',
      description:
        'Requires `workflows.read`. People can read drafts. Drafts never run and grant no access to connected systems.',
    },
    create: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: drafts,
      pathParams: organizationParamsSchema,
      body: createWorkflowDraftSchema,
      responses: { 200: workflowDraftSchema },
      summary: 'Start a workflow draft',
      description:
        'Requires `workflows.author`. Starts a draft from scratch, from supplied content, or from a published version to edit it. Editing a published workflow never changes that version. Reuse the same ID and body after an uncertain response.',
    },
    get: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${drafts}/:draftId`,
      pathParams: draftParams,
      responses: { 200: workflowDraftSchema },
      summary: 'Read a workflow draft',
    },
    save: {
      method: 'PUT',
      metadata: requires('workflows.author'),
      path: `${drafts}/:draftId`,
      pathParams: draftParams,
      body: saveWorkflowDraftSchema,
      responses: { 200: workflowDraftSchema },
      summary: 'Save a workflow draft',
      description:
        'Requires `workflows.author`. Saves against the revision you loaded. If someone else saved first, the request returns 409 and nothing is overwritten. Reuse the same save ID and body after an uncertain response.',
    },
    publish: {
      method: 'POST',
      metadata: requires('workflows.publish'),
      path: `${drafts}/:draftId/publish`,
      pathParams: draftParams,
      body: publishWorkflowDraftSchema,
      responses: { 200: publishedDraftSchema },
      summary: 'Publish a draft as a new version',
      description:
        'Requires `workflows.publish`. Publishes the exact revision you reviewed as an immutable version. Publishing does not activate the workflow or grant it access to anything. Retrying the same revision returns the same version.',
    },
    discard: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: `${drafts}/:draftId/discard`,
      pathParams: draftParams,
      body: z.object({ revision: z.number().int().positive() }).strict(),
      responses: { 200: z.object({ discarded: z.literal(true) }) },
      summary: 'Discard an unpublished draft',
      description:
        'Requires `workflows.author`. Discards a draft you no longer need. Discarding again is safe. Published drafts are kept.',
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
