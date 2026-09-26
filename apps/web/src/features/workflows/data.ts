import {
  type ActivateWorkflow,
  workflowActivationSchema,
  workflowDetailSchema,
  workflowRunViewSchema,
  workflowSummarySchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

class WorkflowError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

function failure(result: { status: number; body: unknown }): never {
  const message =
    typeof result.body === 'object' &&
    result.body !== null &&
    'message' in result.body &&
    typeof result.body.message === 'string'
      ? result.body.message
      : 'Reload to check the current workflow state.';
  throw new WorkflowError(result.status, message);
}

/** Returns the private cache prefix for one workspace's workflows. */
export const workflowsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'workflows'] as const;

/** Reads the persisted library; does not activate or promote a version. */
export const workflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: workflowsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => workflowSummarySchema.parse(item));
    },
  });

/** Reads the exact versions, grants and prerequisites for one workflow. */
export const workflowOptions = (organizationId: string, definitionId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.detail({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return workflowDetailSchema.parse(result.body);
    },
  });

/** Reads recent runs separately so unavailable history does not hide the workflow. */
export const workflowRunsOptions = (
  organizationId: string,
  definitionId: string,
) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), definitionId, 'runs'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.workflows.runs({
        params: { organizationId, definitionId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) => workflowRunViewSchema.parse(item));
    },
  });

/** Submits a reviewed scope. Keep the same request ID and body when retrying an uncertain response. */
export async function activateWorkflow(
  organizationId: string,
  definitionId: string,
  body: ActivateWorkflow,
) {
  const result = await api.workflows.activate({
    params: { organizationId, definitionId },
    body,
  });
  if (result.status !== 200) return failure(result);

  return workflowActivationSchema.parse(result.body);
}

/** Permanently revokes the exact artifact; repeated submissions are safe. */
export async function revokeWorkflow(
  organizationId: string,
  definitionId: string,
  activationId: string,
  artifactDigest: string,
) {
  const result = await api.workflows.revoke({
    params: { organizationId, definitionId, activationId },
    body: { artifactDigest },
  });
  if (result.status !== 200) return failure(result);

  return workflowActivationSchema.parse(result.body);
}

/** Provides actionable feedback for access loss, stale submissions and uncertain responses. */
export function workflowError(error: unknown) {
  if (error instanceof IdentityError && error.status === 401)
    return 'Your session expired. Sign in again.';
  if (error instanceof IdentityError && error.status === 403)
    return 'Workspace access changed. Refresh to check your permissions.';
  if (error instanceof WorkflowError) return error.feedback;

  return 'The result could not be confirmed. Check your connection, then retry the same request or refresh to inspect its status.';
}

/** Reads the supported Resolution catalog for case evaluation; native definitions have no evaluator yet. */
export const resolutionWorkflowsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...workflowsKey(organizationId), 'evaluation', 'library'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.playbooks.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200) return failure(result);

      return result.body.items.map((item) =>
        workflowSummarySchema.parse({ ...item, category: 'resolution' }),
      );
    },
  });
