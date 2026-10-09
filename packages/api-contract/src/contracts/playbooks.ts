import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  activatePlaybookSchema,
  playbookActivationSchema,
  playbookDetailSchema,
  playbookRunViewSchema,
  playbookSummarySchema,
} from '../playbooks.js';

const params = organizationParamsSchema.extend({
  definitionId: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/),
});
const path = '/v1/organizations/{organizationId}/playbooks';

export const playbooksContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'List workspace playbooks',
      description:
        'Requires `workflows.read`. People can inspect published versions and activation status. Viewing a playbook never activates it.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(playbookSummarySchema) })),
  detail: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}`,
      summary: 'Inspect a playbook',
      description:
        'Read steps, versions, prerequisites and historical grants. Evaluation evidence is explicitly unavailable when no integrated evaluation source exists.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params }))
    .output(playbookDetailSchema),
  runs: endpoint
    .route({
      method: 'GET',
      path: `${path}/{definitionId}/runs`,
      summary: 'Read recent playbook runs',
      description:
        'Returns the 50 most recent runs with issue links and separate execution and verification results. Pilot and unclassified evidence do not establish live success.',
    })
    .meta({
      access: requires('workflows.read'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params }))
    .output(z.object({ items: z.array(playbookRunViewSchema) })),
  activate: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/activations`,
      summary: 'Activate a reviewed version',
      description:
        'Requires `playbooks.activate`. Grants your own principal access to explicit orders on one connection. Review the exact digest, scope and approval behavior. Reuse the same ID and body after an uncertain response. Conflicting, overlapping or stale grants return 409; revoked records cannot be restored.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(z.object({ params: params, body: activatePlaybookSchema }))
    .output(playbookActivationSchema),
  revoke: endpoint
    .route({
      method: 'POST',
      path: `${path}/{definitionId}/activations/{activationId}/revoke`,
      summary: 'Revoke a playbook activation',
      description:
        'Requires `playbooks.activate`. Prevents future admission under this artifact. Repeated revocation is safe. Revocation preserves historical grants and does not undo already-dispatched work.',
    })
    .meta({
      access: requires('playbooks.activate'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params.extend({ activationId: z.string().uuid() }),
        body: z
          .object({ artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      }),
    )
    .output(playbookActivationSchema),
};
