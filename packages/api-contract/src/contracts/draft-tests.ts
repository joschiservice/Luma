import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  draftTestExamplesSchema,
  draftTestRunSchema,
  draftTestSummarySchema,
  runDraftTestsSchema,
  saveDraftTestsSchema,
  startDraftTestSchema,
} from '../draft-tests.js';

const draft = '/v1/organizations/{organizationId}/workflow-drafts/{draftId}';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});
const runParams = draftParams.extend({ runId: z.string().uuid() });

export const draftTestsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: `${draft}/tests`,
      summary: 'List saved test cases and their results',
      description:
        'Requires `workflows.read`. People can read saved test cases and whether each passed on the current draft revision. A case without a result has not run on this revision yet.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams }))
    .output(draftTestSummarySchema),
  save: endpoint
    .route({
      method: 'PUT',
      path: `${draft}/tests`,
      summary: 'Save test cases for a draft',
      description:
        'Requires `workflows.author`. Replaces the saved test cases against the revision you loaded (0 before any are saved). If someone else saved first, the request returns 409. Retrying the same body after an uncertain response is safe.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: saveDraftTestsSchema }))
    .output(draftTestSummarySchema),
  runAll: endpoint
    .route({
      method: 'POST',
      path: `${draft}/tests/run`,
      summary: 'Run saved test cases on the current revision',
      description:
        'Requires `workflows.author`. Runs every saved case that has no passing or running result on this draft revision. Call it after saving the draft and before publishing. Repeating the call is safe. Tests use example replies and never contact connected systems.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: runDraftTestsSchema }))
    .output(draftTestSummarySchema),
  examples: endpoint
    .route({
      method: 'GET',
      path: `${draft}/test-examples`,
      summary: 'Suggest example data for a test',
      description:
        'Returns a case filled from the declared fields, cases from recent runs of the published workflow this draft edits that you can read, and scenarios from installed adapters. Nothing is saved.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams }))
    .output(draftTestExamplesSchema),
  start: endpoint
    .route({
      method: 'POST',
      path: `${draft}/test-runs`,
      summary: 'Test a draft with example data',
      description:
        'Requires `workflows.author`. Runs the current draft revision with a saved or unsaved case. The run uses the production workflow interpreter with example replies instead of connected systems, Action Admission or action adapters. A passing test grants no activation or approval. Poll the run until it finishes. Reuse the same ID and body after an uncertain response.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: draftParams, body: startDraftTestSchema }))
    .output(draftTestRunSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: `${draft}/test-runs/{runId}`,
      summary: 'Read a test run you started',
      description:
        'Shows each step the run reached with its values, the path taken and where it would wait for a person.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: runParams }))
    .output(draftTestRunSchema),
  cancel: endpoint
    .route({
      method: 'POST',
      path: `${draft}/test-runs/{runId}/cancel`,
      summary: 'Cancel a test run you started',
      description:
        'Stops the run, including any Code Step. Cancelling a finished run returns it unchanged.',
    })
    .meta({
      access: requires('workflows.author'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: runParams, body: z.object({}).strict() }))
    .output(draftTestRunSchema),
};
