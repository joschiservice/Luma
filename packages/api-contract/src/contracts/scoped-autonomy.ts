import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  autonomyListSchema,
  autonomyPolicyControlSchema,
  autonomyPolicyDraftSchema,
  autonomyPolicySchema,
  autonomyPreviewSchema,
} from '../scoped-autonomy.js';

const path = '/v1/organizations/{organizationId}/autonomy';
const params = organizationParamsSchema.extend({ policyId: z.string().uuid() });
const access = requires('workspace.approval_policy.manage');
const errors = [400, 401, 403, 404, 409, 422, 503] as const;

/** Workspace policy managers review scoped delegation through versioned, idempotent commands. */
export const scopedAutonomyContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read scoped autonomy policies',
      description:
        'Lists reviewed scopes, effective modes and their live, synthetic and unknown track records. Unreleased workspaces return available false and no policies.',
    })
    .meta({ access, errors: [...errors] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(autonomyListSchema),
  save: endpoint
    .route({
      method: 'POST',
      path,
      summary: 'Save a reviewed autonomy scope',
      description:
        'Creates a Manual policy or updates an existing scope by its reviewed revision. Changing scope demotes Autonomous to Assisted and invalidates old approval decisions. Command IDs bind the exact request and actor; repeats return the recorded result.',
    })
    .meta({ access, errors: [...errors] })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: autonomyPolicyDraftSchema,
      }),
    )
    .output(autonomyPolicySchema),
  control: endpoint
    .route({
      method: 'POST',
      path: `${path}/{policyId}/control`,
      summary: 'Pause, resume or explicitly promote a scoped policy',
      description:
        'Controls require the current revision and a reason. Promotion to Autonomous needs live reviewed and independently verified history. Synthetic data, unknown evidence and model confidence never grant autonomy. Pause prevents new reservations; dispatched effects remain visible for reconciliation.',
    })
    .meta({ access, errors: [...errors] })
    .input(z.object({ params, body: autonomyPolicyControlSchema }))
    .output(autonomyPolicySchema),
  preview: endpoint
    .route({
      method: 'GET',
      path: `${path}/{policyId}/preview`,
      summary: 'Preview the current policy against recorded work',
      description:
        'Applies the current scope, risk and freshness limits to up to 100 historical owner-read samples. Reports each sample as live, synthetic or unknown. This is a review aid, not authorization or evidence of production efficacy.',
    })
    .meta({ access, errors: [...errors] })
    .input(z.object({ params }))
    .output(autonomyPreviewSchema),
};
