import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  activatePlaybookSchema,
  playbookActivationSchema,
  playbookDetailSchema,
  playbookRunViewSchema,
  playbookSummarySchema,
} from '../playbooks.js';

const c = initContract();
const params = organizationParamsSchema.extend({
  definitionId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
});
const path = '/v1/organizations/:organizationId/playbooks';

export const playbooksContract = c.router(
  {
    list: {
      method: 'GET',
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(playbookSummarySchema) }) },
      summary: 'List workspace playbooks',
      description:
        'Members can inspect published versions and activation status. Viewing a playbook never activates it.',
    },
    detail: {
      method: 'GET',
      path: `${path}/:definitionId`,
      pathParams: params,
      responses: { 200: playbookDetailSchema },
      summary: 'Inspect a playbook',
      description:
        'Read steps, versions, prerequisites and historical grants. Evaluation evidence is explicitly unavailable when no integrated evaluation source exists.',
    },
    runs: {
      method: 'GET',
      path: `${path}/:definitionId/runs`,
      pathParams: params,
      responses: { 200: z.object({ items: z.array(playbookRunViewSchema) }) },
      summary: 'Read recent playbook runs',
      description:
        'Returns the 50 most recent runs with issue links and separate execution and verification results. Pilot and unclassified evidence do not establish live success.',
    },
    activate: {
      method: 'POST',
      path: `${path}/:definitionId/activations`,
      pathParams: params,
      body: activatePlaybookSchema,
      responses: { 200: playbookActivationSchema },
      summary: 'Activate a reviewed version',
      description:
        'Owners and admins grant their own principal access to explicit orders on one connection. Review the exact digest, scope and approval behavior. Reuse the same ID and body after an uncertain response. Conflicting, overlapping or stale grants return 409; revoked records cannot be restored.',
    },
    revoke: {
      method: 'POST',
      path: `${path}/:definitionId/activations/:activationId/revoke`,
      pathParams: params.extend({ activationId: z.string().uuid() }),
      body: z
        .object({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      responses: { 200: playbookActivationSchema },
      summary: 'Revoke a playbook activation',
      description:
        'Owners and admins prevent future admission under this artifact. Repeated revocation is safe. Revocation preserves historical grants and does not undo already-dispatched work.',
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
