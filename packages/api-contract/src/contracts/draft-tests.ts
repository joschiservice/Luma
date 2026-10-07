import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  draftTestExamplesSchema,
  draftTestRunSchema,
  draftTestSummarySchema,
  runDraftTestsSchema,
  saveDraftTestsSchema,
  startDraftTestSchema,
} from '../draft-tests.js';

const c = initContract();
const draft = '/v1/organizations/:organizationId/workflow-drafts/:draftId';
const draftParams = organizationParamsSchema.extend({
  draftId: z.string().uuid(),
});
const runParams = draftParams.extend({ runId: z.string().uuid() });

export const draftTestsContract = c.router(
  {
    list: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${draft}/tests`,
      pathParams: draftParams,
      responses: { 200: draftTestSummarySchema },
      summary: 'List saved test cases and their results',
      description:
        'Requires `workflows.read`. People can read saved test cases and whether each passed on the current draft revision. A case without a result has not run on this revision yet.',
    },
    save: {
      method: 'PUT',
      metadata: requires('workflows.author'),
      path: `${draft}/tests`,
      pathParams: draftParams,
      body: saveDraftTestsSchema,
      responses: { 200: draftTestSummarySchema },
      summary: 'Save test cases for a draft',
      description:
        'Requires `workflows.author`. Replaces the saved test cases against the revision you loaded (0 before any are saved). If someone else saved first, the request returns 409. Retrying the same body after an uncertain response is safe.',
    },
    runAll: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: `${draft}/tests/run`,
      pathParams: draftParams,
      body: runDraftTestsSchema,
      responses: { 200: draftTestSummarySchema },
      summary: 'Run saved test cases on the current revision',
      description:
        'Requires `workflows.author`. Runs every saved case that has no passing or running result on this draft revision. Call it after saving the draft and before publishing. Repeating the call is safe. Tests use example replies and never contact connected systems.',
    },
    examples: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${draft}/test-examples`,
      pathParams: draftParams,
      responses: { 200: draftTestExamplesSchema },
      summary: 'Suggest example data for a test',
      description:
        'Returns a case filled from the declared fields, cases from recent runs of the published workflow this draft edits that you can read, and scenarios from installed adapters. Nothing is saved.',
    },
    start: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: `${draft}/test-runs`,
      pathParams: draftParams,
      body: startDraftTestSchema,
      responses: { 200: draftTestRunSchema },
      summary: 'Test a draft with example data',
      description:
        'Requires `workflows.author`. Runs the current draft revision with a saved or unsaved case. The run uses the production workflow interpreter with example replies instead of connected systems, Action Admission or action adapters. A passing test grants no activation or approval. Poll the run until it finishes. Reuse the same ID and body after an uncertain response.',
    },
    get: {
      method: 'GET',
      metadata: requires('workflows.read'),
      path: `${draft}/test-runs/:runId`,
      pathParams: runParams,
      responses: { 200: draftTestRunSchema },
      summary: 'Read a test run you started',
      description:
        'Shows each step the run reached with its values, the path taken and where it would wait for a person.',
    },
    cancel: {
      method: 'POST',
      metadata: requires('workflows.author'),
      path: `${draft}/test-runs/:runId/cancel`,
      pathParams: runParams,
      body: z.object({}).strict(),
      responses: { 200: draftTestRunSchema },
      summary: 'Cancel a test run you started',
      description:
        'Stops the run, including any Code Step. Cancelling a finished run returns it unchanged.',
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
