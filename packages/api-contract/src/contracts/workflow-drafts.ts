import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
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

const drafts = '/v1/organizations/{organizationId}/workflow-drafts';
const authoring = '/v1/organizations/{organizationId}/workflow-authoring';
const templates = '/v1/organizations/{organizationId}/workflow-templates';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});

export const workflowDraftsContract = {
  templates: endpoint
    .route({
      method: 'GET',
      path: templates,
      summary: 'List workflow templates',
      description:
        'Returns templates from installed adapters with what each needs before it can run, its readiness and its activation status here.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(workflowTemplateSchema) })),
  installTemplate: endpoint
    .route({
      method: 'POST',
      path: `${templates}/{templateId}/install`,
      summary: 'Add a template to this workspace',
      description:
        'Requires `workflows.publish`. Publishes the template’s reviewed version here so it can be configured. Repeating the request is safe. Adding a template never activates it.',
    })
    .meta({
      access: requires('workflows.publish'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          templateId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
        }),
        body: z.object({}).strict(),
      }),
    )
    .output(workflowTemplateSchema),
  vocabulary: endpoint
    .route({
      method: 'GET',
      path: `${authoring}/vocabulary`,
      summary: 'List what workflows can use in this workspace',
      description:
        'Returns triggers, step types, subjects, data sources, actions and result checks from installed adapters. Entries that cannot run here are included with the reason.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(authoringVocabularySchema),
  validate: endpoint
    .route({
      method: 'POST',
      path: `${authoring}/validate`,
      summary: 'Check a draft without saving it',
      description:
        'Checks a saved draft or supplied content. Diagnostics name the step and field to fix. Errors block publishing; warnings describe what cannot run in this workspace yet. Validation changes nothing.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: validateWorkflowDraftSchema,
      }),
    )
    .output(draftValidationSchema),
  list: endpoint
    .route({
      method: 'GET',
      path: drafts,
      summary: 'List open workflow drafts',
      description:
        'Requires `workflows.read`. People can read drafts. Drafts never run and grant no access to connected systems.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(workflowDraftSchema) })),
  create: endpoint
    .route({
      method: 'POST',
      path: drafts,
      summary: 'Start a workflow draft',
      description:
        'Requires `workflows.author`. Starts a draft from scratch, from supplied content, or from a published version to edit it. Editing a published workflow never changes that version. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: createWorkflowDraftSchema,
      }),
    )
    .output(workflowDraftSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: `${drafts}/{draftId}`,
      summary: 'Read a workflow draft',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams }))
    .output(workflowDraftSchema),
  save: endpoint
    .route({
      method: 'PUT',
      path: `${drafts}/{draftId}`,
      summary: 'Save a workflow draft',
      description:
        'Requires `workflows.author`. Saves against the revision you loaded. If someone else saved first, the request returns 409 and nothing is overwritten. Reuse the same save ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: saveWorkflowDraftSchema }))
    .output(workflowDraftSchema),
  publish: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/{draftId}/publish`,
      summary: 'Publish a draft as a new version',
      description:
        'Requires `workflows.publish`. Publishes the exact revision you reviewed as an immutable version. Publishing does not activate the workflow or grant it access to anything. Retrying the same revision returns the same version.',
    })
    .meta({
      access: requires('workflows.publish'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: publishWorkflowDraftSchema }))
    .output(publishedDraftSchema),
  discard: endpoint
    .route({
      method: 'POST',
      path: `${drafts}/{draftId}/discard`,
      summary: 'Discard an unpublished draft',
      description:
        'Requires `workflows.author`. Discards a draft you no longer need. Discarding again is safe. Published drafts are kept.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: draftParams,
        body: z.object({ revision: z.number().int().positive() }).strict(),
      }),
    )
    .output(z.object({ discarded: z.literal(true) })),
};
